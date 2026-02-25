/*---------------------------------------------------------------------------------------------
 *  StackCode - OpenAI Compatible Prompt Builder
 *
 *  Builds user_prompt strings in OpenAI Chat Completion API format for Stackspot AI.
 *  Since Stackspot only accepts a single user_prompt string, we encode the entire
 *  OpenAI-style request (messages, tools, response_format) as a JSON string.
 *
 *  This leverages the fact that modern LLMs were extensively trained on the OpenAI
 *  format, making them more likely to produce correct, predictable responses even
 *  when the API itself doesn't natively support these features.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { OpenAiFunctionTool } from '../networking/common/fetch';
import { getTextPart } from '../chat/common/globalStringUtils';

/**
 * OpenAI Chat Completion API - Message format
 */
export interface OpenAIChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	name?: string;
	tool_calls?: OpenAIChatMessageToolCall[];
	tool_call_id?: string;
}

/**
 * Tool call within an assistant message
 */
export interface OpenAIChatMessageToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string; // JSON string
	};
}

/**
 * Tool definition for OpenAI format
 */
export interface OpenAITool {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters?: object;
	};
}

/**
 * Response format specification
 */
export interface OpenAIResponseFormat {
	type: 'text' | 'json_object' | 'json_schema';
	json_schema?: {
		name: string;
		strict?: boolean;
		schema: object;
	};
}

/**
 * Complete OpenAI Chat Completion request structure
 */
export interface OpenAIChatRequest {
	model: string;
	messages: OpenAIChatMessage[];
	tools?: OpenAITool[];
	tool_choice?: 'none' | 'auto' | { type: 'function'; function: { name: string } };
	response_format?: OpenAIResponseFormat;
	stream?: boolean;
}

/**
 * Configuration options for prompt building
 */
export interface PromptBuilderOptions {
	/** Model identifier (for compatibility, not used by Stackspot) */
	model?: string;
	/** Optional forced tool name for tool_choice simulation */
	forcedToolName?: string;
	/** Maximum characters for tool results before truncation */
	maxToolResultChars?: number;
	/** Maximum total history characters before compression */
	maxHistoryChars?: number;
	/** Number of recent tool results to preserve during compression */
	preserveRecentCount?: number;
	/** Threshold for truncating individual tool results */
	toolResultTruncateThreshold?: number;
}

/**
 * System instruction that teaches the LLM how to respond in OpenAI format.
 * This is injected at the beginning of the conversation.
 */
export const OPENAI_FORMAT_SYSTEM_INSTRUCTION = `[CRITICAL] You MUST respond with a valid JSON object following the OpenAI Chat Completion API format.

Your response MUST be a single, valid JSON object with this exact structure:
{
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "your text response here (or empty string if using tool_calls)",
        "tool_calls": [
          {
            "id": "call_abc123",
            "type": "function",
            "function": {
              "name": "tool_name",
              "arguments": "{\\"param1\\":\\"value1\\",\\"param2\\":\\"value2\\"}"
            }
          }
        ]
      },
      "finish_reason": "stop"
    }
  ]
}

RULES:
1. Respond ONLY with the JSON object - no text before or after
2. Do NOT use markdown code fences (\`\`\`json)
3. If calling tools: include them in tool_calls array, content can be empty or brief
4. If not calling tools: tool_calls should be an empty array [] or omitted
5. All string values must be properly escaped for JSON
6. The arguments field in function must be a JSON-encoded string (double-escaped)`;

/**
 * Format reminder injected at the end to reinforce JSON response rules.
 */
export const OPENAI_FORMAT_REMINDER = `[RESPONSE FORMAT REMINDER] Your ENTIRE response MUST be a valid JSON object following the OpenAI Chat Completion API format shown in the system instruction.

CRITICAL:
- Respond ONLY with JSON, no markdown, no extra text
- Tool calls go in choices[0].message.tool_calls array
- The arguments field must be a properly escaped JSON string
- All quotes inside strings must be escaped with backslash`;

/**
 * Compact inline format reminder for sandwich prompting.
 */
export const OPENAI_INLINE_FORMAT_REMINDER = `[FORMAT] Respond with valid OpenAI ChatCompletion JSON only. No markdown, no extra text.`;

/**
 * Default configuration values
 */
const DEFAULT_OPTIONS: Required<PromptBuilderOptions> = {
	model: 'stackspot-agent',
	forcedToolName: undefined as unknown as string,
	maxToolResultChars: 150 * 1024, // 150 KB
	maxHistoryChars: 80 * 1024, // 80 KB
	preserveRecentCount: 5,
	toolResultTruncateThreshold: 500,
};

/**
 * Converts OpenAiFunctionTool[] to OpenAITool[] format
 */
function convertToolsToOpenAIFormat(tools: OpenAiFunctionTool[]): OpenAITool[] {
	return tools.map(tool => ({
		type: 'function',
		function: {
			name: tool.function.name,
			description: tool.function.description,
			parameters: tool.function.parameters ?? { type: 'object' },
		},
	}));
}

/**
 * Converts Raw.ChatMessage[] to OpenAIChatMessage[] format
 */
function convertMessagesToOpenAIFormat(
	messages: Raw.ChatMessage[],
	options: PromptBuilderOptions = {}
): OpenAIChatMessage[] {
	const result: OpenAIChatMessage[] = [];

	for (const message of messages) {
		switch (message.role) {
			case Raw.ChatRole.System: {
				const text = getTextPart(message.content);
				if (text.trim()) {
					result.push({
						role: 'system',
						content: text.trim(),
					});
				}
				break;
			}

			case Raw.ChatRole.User: {
				const text = getTextPart(message.content);
				if (text.trim()) {
					result.push({
						role: 'user',
						content: text.trim(),
					});
				}
				break;
			}

			case Raw.ChatRole.Assistant: {
				const assistantMsg = message as Raw.AssistantChatMessage;
				const text = getTextPart(assistantMsg.content);
				const openaiMsg: OpenAIChatMessage = {
					role: 'assistant',
					content: text.trim(),
				};

				// Convert tool calls if present
				if (assistantMsg.toolCalls && assistantMsg.toolCalls.length > 0) {
					openaiMsg.tool_calls = assistantMsg.toolCalls.map(tc => ({
						id: tc.id,
						type: 'function',
						function: {
							name: tc.function.name,
							arguments: tc.function.arguments,
						},
					}));
				}

				result.push(openaiMsg);
				break;
			}

			case Raw.ChatRole.Tool: {
				const toolMsg = message as Raw.ToolChatMessage;
				let text = getTextPart(toolMsg.content);

				// Apply truncation if needed
				const maxChars = options.maxToolResultChars ?? DEFAULT_OPTIONS.maxToolResultChars;
				if (text.length > maxChars) {
					const keepStart = Math.floor(maxChars * 0.6);
					const keepEnd = maxChars - keepStart;
					const originalLen = text.length;
					text = text.slice(0, keepStart) +
						`\n\n[... Tool result truncated from ${Math.round(originalLen / 1024)}KB to ${Math.round(maxChars / 1024)}KB ...]\n\n` +
						text.slice(-keepEnd);
				}

				result.push({
					role: 'tool',
					content: text.trim(),
					tool_call_id: toolMsg.toolCallId ?? 'unknown',
				});
				break;
			}
		}
	}

	return result;
}

/**
 * Compresses conversation history by truncating older tool results
 */
function compressHistory(
	messages: OpenAIChatMessage[],
	options: PromptBuilderOptions
): OpenAIChatMessage[] {
	const maxHistoryChars = options.maxHistoryChars ?? DEFAULT_OPTIONS.maxHistoryChars;
	const preserveRecent = options.preserveRecentCount ?? DEFAULT_OPTIONS.preserveRecentCount;
	const truncateThreshold = options.toolResultTruncateThreshold ?? DEFAULT_OPTIONS.toolResultTruncateThreshold;

	// Calculate total size
	const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
	if (totalChars <= maxHistoryChars) {
		return messages;
	}

	// Find tool messages (role === 'tool')
	const toolIndices: number[] = [];
	messages.forEach((msg, idx) => {
		if (msg.role === 'tool') {
			toolIndices.push(idx);
		}
	});

	// If not enough tool messages to worry about, return as-is
	if (toolIndices.length <= preserveRecent) {
		return messages;
	}

	// Truncate older tool results
	const truncatableIndices = toolIndices.slice(0, toolIndices.length - preserveRecent);
	const compressed = [...messages];
	let truncatedCount = 0;
	let savedChars = 0;

	for (const idx of truncatableIndices) {
		const msg = compressed[idx];
		if (msg.content.length > truncateThreshold) {
			const originalLen = msg.content.length;
			compressed[idx] = {
				...msg,
				content: `[Tool result truncated for context management - original ${Math.round(originalLen / 1024)}KB]`,
			};
			savedChars += originalLen - compressed[idx].content.length;
			truncatedCount++;
		}

		// Stop if we're under the threshold
		const currentTotal = compressed.reduce((sum, m) => sum + m.content.length, 0);
		if (currentTotal <= maxHistoryChars) {
			break;
		}
	}

	if (truncatedCount > 0) {
		console.log(`[stackcode] History compression: truncated ${truncatedCount} old tool results, saved ~${Math.round(savedChars / 1024)}KB`);
	}

	return compressed;
}

/**
 * Injects inline format reminder using sandwich prompting technique
 */
function injectInlineFormatReminder(messages: OpenAIChatMessage[]): OpenAIChatMessage[] {
	if (messages.length < 4) {
		return messages;
	}

	// Find the last user message
	let lastUserIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === 'user') {
			lastUserIdx = i;
			break;
		}
	}

	if (lastUserIdx <= 0) {
		return messages;
	}

	// Insert format reminder before the last user message
	const result = [...messages];
	result.splice(lastUserIdx, 0, {
		role: 'system',
		content: OPENAI_INLINE_FORMAT_REMINDER,
	});

	return result;
}

/**
 * Builds an OpenAI-compatible user_prompt string from messages and tools.
 * This creates a JSON representation of an OpenAI Chat Completion request.
 *
 * @param messages - Array of chat messages
 * @param tools - Optional array of tool definitions
 * @param options - Configuration options
 * @returns JSON string representing an OpenAI ChatCompletion request
 */
export function buildOpenAICompatiblePrompt(
	messages: Raw.ChatMessage[],
	tools?: OpenAiFunctionTool[],
	options: PromptBuilderOptions = {}
): string {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const hasTools = tools && tools.length > 0;

	// Convert messages to OpenAI format
	let openaiMessages = convertMessagesToOpenAIFormat(messages, opts);

	// Prepend format system instruction if tools are present
	if (hasTools) {
		openaiMessages.unshift({
			role: 'system',
			content: OPENAI_FORMAT_SYSTEM_INSTRUCTION,
		});
	}

	// Compress history if needed
	openaiMessages = compressHistory(openaiMessages, opts);

	// Inject inline format reminder for long conversations
	if (hasTools) {
		openaiMessages = injectInlineFormatReminder(openaiMessages);
	}

	// Build the request object
	const request: OpenAIChatRequest = {
		model: opts.model,
		messages: openaiMessages,
	};

	// Add tools if present
	if (hasTools) {
		request.tools = convertToolsToOpenAIFormat(tools);
	}

	// Add forced tool choice if specified
	if (opts.forcedToolName && hasTools) {
		request.tool_choice = {
			type: 'function',
			function: { name: opts.forcedToolName },
		};
	}

	// Append format reminder at the end
	if (hasTools) {
		request.messages.push({
			role: 'system',
			content: OPENAI_FORMAT_REMINDER,
		});
	}

	// Serialize to JSON with pretty printing for readability
	return JSON.stringify(request, null, 2);
}

/**
 * Legacy prompt builder that uses XML format.
 * Kept for backward compatibility and fallback scenarios.
 */
export { formatToolDefinitionsForPrompt, getToolCallingSystemPrompt } from './toolCallParser';
