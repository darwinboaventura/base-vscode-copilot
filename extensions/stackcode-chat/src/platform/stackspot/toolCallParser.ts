/*---------------------------------------------------------------------------------------------
 *  StackCode - Streaming Output Compiler / Tool Call Parser
 *
 *  Parses XML-tagged streaming output from the LLM and emits typed events
 *  as they become available. Adapted from the working fork's OutputCompiler
 *  to integrate with the ChatEndpoint/FinishedCallback architecture.
 *
 *  Expected LLM response format (ALL content must be inside XML tags):
 *
 *    <thinking>reasoning text here</thinking>
 *
 *    <tool_use>{"name":"create_file","parameters":{"filePath":"...","content":"..."}}</tool_use>
 *
 *    <text>Plain text response to the user</text>
 *
 *  Valid tags: <thinking>, <text>, <tool_use>, <code>, <progress>
 *  Text outside XML tags is silently discarded (by design).
 *  Tool calls use JSON inside <tool_use> tags (not nested XML).
 *--------------------------------------------------------------------------------------------*/

/**
 * Represents a parsed tool call extracted from the LLM response.
 */
export interface ParsedToolCall {
	name: string;
	arguments: string;
	id: string;
}

/**
 * Events emitted by the streaming parser.
 */
export const enum ToolCallParserEventKind {
	/** Plain text content (inside <text> block) */
	Text,
	/** A complete tool call has been parsed */
	ToolCallComplete,
	/** A tool call has started — emitted when we enter <tool_use> */
	ToolCallBegin,
	/** Tool call arguments are being streamed (not used in new format — tool_use is accumulated) */
	ToolCallArgumentsDelta,
	/** Thinking text (inside <thinking> block) */
	Thinking,
}

export interface ITextEvent {
	kind: ToolCallParserEventKind.Text;
	text: string;
}

export interface IToolCallCompleteEvent {
	kind: ToolCallParserEventKind.ToolCallComplete;
	toolCall: ParsedToolCall;
}

export interface IToolCallBeginEvent {
	kind: ToolCallParserEventKind.ToolCallBegin;
	name: string;
	id: string;
}

export interface IToolCallArgumentsDeltaEvent {
	kind: ToolCallParserEventKind.ToolCallArgumentsDelta;
	name: string;
	id: string;
	argumentsDelta: string;
}

export interface IThinkingEvent {
	kind: ToolCallParserEventKind.Thinking;
	text: string;
}

export type ToolCallParserEvent =
	| ITextEvent
	| IToolCallCompleteEvent
	| IToolCallBeginEvent
	| IToolCallArgumentsDeltaEvent
	| IThinkingEvent;

// Known XML tags the LLM is instructed to use
const KNOWN_TAGS = new Set(['thinking', 'text', 'tool_use', 'code', 'progress']);

/**
 * Streaming parser for XML-tagged LLM output.
 *
 * Adapted from the working fork's OutputCompiler to emit ToolCallParserEvent
 * objects compatible with the ChatEndpoint/FinishedCallback architecture.
 *
 * Key behaviors:
 * - <thinking> content is streamed chunk-by-chunk immediately
 * - <text> content is streamed chunk-by-chunk immediately
 * - <tool_use> content is accumulated silently, validated on close, then emitted
 * - <code> content is streamed immediately
 * - <progress> content is streamed immediately
 * - Text outside XML tags is accumulated for raw JSON fallback recovery
 *
 * Usage:
 *   const parser = new StreamingToolCallParser();
 *   for (const chunk of sseChunks) {
 *     const events = parser.feed(chunk);
 *     for (const event of events) { handle(event); }
 *   }
 *   const finalEvents = parser.flush();
 */
export class StreamingToolCallParser {
	private static _globalToolUseCounter = Date.now();

	private _state: ParserState = ParserState.Outside;
	private _inputBuffer: string[] = [];
	private _currentBuffer = '';
	private _outsideAccumulator = '';
	private _toolCallIdCounter = 0;
	private _detectedToolCalls = false;

	/**
	 * Feed a chunk of text into the parser.
	 * Returns an array of events detected in this chunk.
	 */
	public feed(chunk: string): ToolCallParserEvent[] {
		if (!chunk) {
			return [];
		}
		this._inputBuffer.push(chunk);
		return this._processBuffer();
	}

	/**
	 * Flush any remaining buffered content as events.
	 * Call this when the stream ends.
	 */
	public flush(): ToolCallParserEvent[] {
		const events: ToolCallParserEvent[] = [];

		// Process any remaining input
		if (this._inputBuffer.length) {
			const remaining = this._inputBuffer.join('');
			this._inputBuffer.length = 0;
			if (this._state === ParserState.Outside) {
				this._outsideAccumulator += remaining;
			} else {
				this._currentBuffer += remaining;
			}
		}

		// Handle unclosed blocks
		switch (this._state) {
			case ParserState.InThinking:
				if (this._currentBuffer) {
					events.push({ kind: ToolCallParserEventKind.Thinking, text: this._currentBuffer });
				}
				break;
			case ParserState.InText:
				if (this._currentBuffer) {
					events.push({ kind: ToolCallParserEventKind.Text, text: this._currentBuffer });
				}
				break;
			case ParserState.InToolUse:
				if (this._currentBuffer) {
					const toolCall = this._safeParseToolUse(this._currentBuffer);
					if (toolCall) {
						const id = this._nextToolCallId();
						events.push({
							kind: ToolCallParserEventKind.ToolCallBegin,
							name: toolCall.name,
							id,
						});
						events.push({
							kind: ToolCallParserEventKind.ToolCallComplete,
							toolCall: { name: toolCall.name, arguments: JSON.stringify(toolCall.parameters), id },
						});
						this._detectedToolCalls = true;
					} else {
						const preview = this._currentBuffer.trim().substring(0, 200);
						console.warn(`[StreamingToolCallParser] Failed to parse unclosed <tool_use> content on flush: ${preview}${this._currentBuffer.length > 200 ? '...' : ''}`);
					}
				}
				break;
			case ParserState.InCode:
			case ParserState.InProgress:
				// Code and progress are emitted as text
				if (this._currentBuffer) {
					events.push({ kind: ToolCallParserEventKind.Text, text: this._currentBuffer });
				}
				break;
			default:
				break;
		}

		this._resetState();

		// Try to recover raw JSON tool calls from content outside XML tags
		if (this._outsideAccumulator.trim()) {
			const recovered = this._extractRawToolCalls(this._outsideAccumulator);
			for (const tc of recovered) {
				events.push({
					kind: ToolCallParserEventKind.ToolCallBegin,
					name: tc.name,
					id: tc.id,
				});
				events.push({
					kind: ToolCallParserEventKind.ToolCallComplete,
					toolCall: tc,
				});
				this._detectedToolCalls = true;
			}
			this._outsideAccumulator = '';
		}

		return events;
	}

	/**
	 * Whether any tool calls have been detected so far.
	 */
	public get hasToolCalls(): boolean {
		return this._detectedToolCalls;
	}

	// =========================================================================
	// Internal — Main loop
	// =========================================================================

	private _processBuffer(): ToolCallParserEvent[] {
		const events: ToolCallParserEvent[] = [];
		let safety = 0;

		while (safety++ < 10_000) {
			if (this._state === ParserState.Outside) {
				if (!this._consumeOutsideState(events)) {
					break;
				}
				continue;
			}

			switch (this._state) {
				case ParserState.InThinking:
					if (!this._consumeBlock('thinking',
						chunk => events.push({ kind: ToolCallParserEventKind.Thinking, text: chunk }),
						_content => { /* thinking completed — no extra event needed */ },
					)) {
						return events;
					}
					break;

				case ParserState.InText:
					if (!this._consumeBlock('text',
						chunk => events.push({ kind: ToolCallParserEventKind.Text, text: chunk }),
						_content => { /* text completed — no extra event needed */ },
					)) {
						return events;
					}
					break;

				case ParserState.InToolUse:
					if (!this._consumeToolUse(events)) {
						return events;
					}
					break;

				case ParserState.InCode:
					// Code blocks are streamed as text
					if (!this._consumeBlock('code',
						chunk => events.push({ kind: ToolCallParserEventKind.Text, text: chunk }),
						_content => { /* code completed */ },
					)) {
						return events;
					}
					break;

				case ParserState.InProgress:
					// Progress is streamed as thinking
					if (!this._consumeBlock('progress',
						chunk => events.push({ kind: ToolCallParserEventKind.Thinking, text: chunk }),
						_content => { /* progress completed */ },
					)) {
						return events;
					}
					break;

				default:
					break;
			}
		}

		return events;
	}

	// =========================================================================
	// Internal — State transitions
	// =========================================================================

	/**
	 * Looks for the next opening tag in the pending buffer.
	 * Returns true if progress was made, false if we need more data.
	 */
	private _consumeOutsideState(events: ToolCallParserEvent[]): boolean {
		const pending = this._inputBuffer.join('');
		if (!pending) {
			return false;
		}

		const openIndex = pending.indexOf('<');
		if (openIndex === -1) {
			// No tag found — accumulate for raw JSON recovery fallback
			this._outsideAccumulator += pending;
			this._inputBuffer.length = 0;
			return false;
		}

		// Accumulate anything before the tag for raw JSON recovery
		if (openIndex > 0) {
			this._outsideAccumulator += pending.substring(0, openIndex);
		}
		this._inputBuffer.length = 0;
		const trimmed = pending.substring(openIndex);

		const closeIndex = trimmed.indexOf('>');
		if (closeIndex === -1) {
			// Incomplete tag — buffer and wait for more data
			this._inputBuffer.push(trimmed);
			return false;
		}

		const tagContent = trimmed.substring(1, closeIndex);
		const parsedTag = this._parseTag(tagContent);
		const remainder = trimmed.substring(closeIndex + 1);

		if (remainder) {
			this._inputBuffer.push(remainder);
		}

		if (!parsedTag) {
			// Unknown tag or closing tag — skip and try again
			return true;
		}

		switch (parsedTag) {
			case 'thinking':
				this._state = ParserState.InThinking;
				break;
			case 'text':
				this._state = ParserState.InText;
				break;
			case 'tool_use':
				this._state = ParserState.InToolUse;
				break;
			case 'code':
				this._state = ParserState.InCode;
				break;
			case 'progress':
				this._state = ParserState.InProgress;
				break;
			default:
				return true;
		}

		this._currentBuffer = '';
		return true;
	}

	/**
	 * Reads content inside a block until the closing tag.
	 * Streams consumable content immediately while keeping a guard buffer
	 * to avoid splitting a closing tag across chunks.
	 *
	 * Returns true if the block was fully consumed, false if waiting for more data.
	 */
	private _consumeBlock(
		tagName: string,
		onChunk: (chunk: string) => void,
		onComplete: (content: string) => void,
	): boolean {
		const pending = this._inputBuffer.join('');
		const closeTag = `</${tagName}>`;
		const closeIndex = pending.indexOf(closeTag);

		if (closeIndex === -1) {
			// Closing tag not found — stream what's safe and keep a guard
			if (pending) {
				const guardLength = Math.max(closeTag.length - 1, 0);
				const cutoff = Math.max(0, pending.length - guardLength);
				const consumable = pending.substring(0, cutoff);
				const leftover = pending.substring(cutoff);

				if (consumable) {
					onChunk(consumable);
					this._currentBuffer += consumable;
				}
				this._inputBuffer.length = 0;
				if (leftover) {
					this._inputBuffer.push(leftover);
				}
			}
			return false;
		}

		// Closing tag found — emit remaining content before it
		const content = pending.substring(0, closeIndex);
		if (content) {
			onChunk(content);
			this._currentBuffer += content;
		}

		this._inputBuffer.length = 0;
		const remainder = pending.substring(closeIndex + closeTag.length);
		if (remainder) {
			this._inputBuffer.push(remainder);
		}

		onComplete(this._currentBuffer);
		this._resetState();
		return true;
	}

	/**
	 * Accumulates tool_use content silently until closing tag.
	 * On close: parses JSON, validates, generates local toolCallId, emits events.
	 */
	private _consumeToolUse(events: ToolCallParserEvent[]): boolean {
		const pending = this._inputBuffer.join('');
		const closeTag = '</tool_use>';
		const closeIndex = pending.indexOf(closeTag);

		if (closeIndex === -1) {
			// Accumulate silently
			if (pending) {
				const guardLength = Math.max(closeTag.length - 1, 0);
				const cutoff = Math.max(0, pending.length - guardLength);
				const consumable = pending.substring(0, cutoff);
				const leftover = pending.substring(cutoff);

				if (consumable) {
					this._currentBuffer += consumable;
				}
				this._inputBuffer.length = 0;
				if (leftover) {
					this._inputBuffer.push(leftover);
				}
			}
			return false;
		}

		this._currentBuffer += pending.substring(0, closeIndex);
		const remainder = pending.substring(closeIndex + closeTag.length);
		this._inputBuffer.length = 0;
		if (remainder) {
			this._inputBuffer.push(remainder);
		}

		const rawContent = this._currentBuffer;
		const payload = this._safeParseToolUse(rawContent);
		this._resetState();

		if (payload) {
			const id = this._nextToolCallId();
			events.push({
				kind: ToolCallParserEventKind.ToolCallBegin,
				name: payload.name,
				id,
			});
			events.push({
				kind: ToolCallParserEventKind.ToolCallComplete,
				toolCall: {
					name: payload.name,
					arguments: JSON.stringify(payload.parameters),
					id,
				},
			});
			this._detectedToolCalls = true;
		} else if (rawContent.trim()) {
			// Log a warning so failed tool_use parsing is never silent.
			// Truncate to avoid flooding logs with large payloads.
			const preview = rawContent.trim().substring(0, 200);
			console.warn(`[StreamingToolCallParser] Failed to parse <tool_use> content: ${preview}${rawContent.length > 200 ? '...' : ''}`);
		}

		return true;
	}

	// =========================================================================
	// Internal — Helpers
	// =========================================================================

	private _resetState(): void {
		this._state = ParserState.Outside;
		this._currentBuffer = '';
	}

	private _parseTag(tagContent: string): string | undefined {
		const normalized = tagContent.trim();
		if (!normalized || normalized.startsWith('/')) {
			return undefined;
		}

		// Extract tag name (before any attributes)
		const spaceIndex = normalized.indexOf(' ');
		const name = (spaceIndex === -1 ? normalized : normalized.substring(0, spaceIndex)).toLowerCase();

		if (!KNOWN_TAGS.has(name)) {
			return undefined;
		}

		return name;
	}

	private _nextToolCallId(): string {
		StreamingToolCallParser._globalToolUseCounter += 1;
		this._toolCallIdCounter++;
		return `tooluse-${StreamingToolCallParser._globalToolUseCounter}`;
	}

	/**
	 * Safely parse tool_use JSON content. Handles multiple fallback strategies:
	 * 1. Direct JSON.parse
	 * 2. Brace-matching extraction (handles extra text around JSON)
	 * 3. Trailing comma removal
	 */
	private _safeParseToolUse(raw: string): { name: string; parameters: Record<string, unknown> } | undefined {
		const trimmed = raw.trim();

		const validate = (parsed: unknown): { name: string; parameters: Record<string, unknown> } | undefined => {
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
				return undefined;
			}
			const obj = parsed as Record<string, unknown>;
			const name = typeof obj.name === 'string' ? obj.name.trim() : '';
			const parametersCandidate = obj.parameters ?? obj.args ?? obj.arguments ?? {};

			if (!name) {
				return undefined;
			}

			// Validate tool name: must be alphanumeric with underscores, hyphens, dots,
			// and slashes (tool names like "stackcode/askQuestions" use slashes).
			if (!/^[a-zA-Z0-9_\-./]+$/.test(name)) {
				return undefined;
			}

			if (typeof parametersCandidate !== 'object' || parametersCandidate === null || Array.isArray(parametersCandidate)) {
				return undefined;
			}

			return { name, parameters: parametersCandidate as Record<string, unknown> };
		};

		// Attempt 1: Direct parse
		try {
			const result = validate(JSON.parse(trimmed));
			if (result) {
				return result;
			}
		} catch { /* fallthrough */ }

		// Attempt 2: Extract JSON object by brace-matching
		const braceIndex = trimmed.indexOf('{');
		if (braceIndex >= 0) {
			const jsonStr = this._extractJsonObject(trimmed, braceIndex);
			if (jsonStr) {
				try {
					const result = validate(JSON.parse(jsonStr));
					if (result) {
						return result;
					}
				} catch { /* fallthrough */ }

				// Attempt 3: Remove trailing commas
				const cleaned = jsonStr.replace(/,\s*([\]}])/g, '$1');
				if (cleaned !== jsonStr) {
					try {
						const result = validate(JSON.parse(cleaned));
						if (result) {
							return result;
						}
					} catch { /* fallthrough */ }
				}
			}
		}

		return undefined;
	}

	/**
	 * Extracts a complete JSON object string by counting matching braces.
	 */
	private _extractJsonObject(raw: string, start: number): string | undefined {
		if (raw[start] !== '{') {
			return undefined;
		}

		let depth = 0;
		let inString = false;
		let escaped = false;

		for (let i = start; i < raw.length; i++) {
			const ch = raw[i];

			if (escaped) {
				escaped = false;
				continue;
			}

			if (ch === '\\' && inString) {
				escaped = true;
				continue;
			}

			if (ch === '"') {
				inString = !inString;
				continue;
			}

			if (inString) {
				continue;
			}

			if (ch === '{') {
				depth++;
			} else if (ch === '}') {
				depth--;
				if (depth === 0) {
					return raw.substring(start, i + 1);
				}
			}
		}

		return undefined;
	}

	/**
	 * Extracts tool call JSON objects from raw text that was not wrapped
	 * in <tool_use> XML tags (fallback recovery).
	 */
	private _extractRawToolCalls(raw: string): ParsedToolCall[] {
		// Strip markdown code blocks to avoid false positives
		const cleaned = raw.replace(/```[\s\S]*?```/g, '');
		const results: ParsedToolCall[] = [];
		let pos = 0;

		while (pos < cleaned.length) {
			const braceIndex = cleaned.indexOf('{', pos);
			if (braceIndex === -1) {
				break;
			}

			const jsonStr = this._extractJsonObject(cleaned, braceIndex);
			if (!jsonStr) {
				pos = braceIndex + 1;
				continue;
			}

			if (!jsonStr.includes('"name"')) {
				pos = braceIndex + jsonStr.length;
				continue;
			}

			const toolCall = this._safeParseToolUse(jsonStr);
			if (toolCall) {
				const id = this._nextToolCallId();
				results.push({
					name: toolCall.name,
					arguments: JSON.stringify(toolCall.parameters),
					id,
				});
			}

			pos = braceIndex + jsonStr.length;
		}

		return results;
	}
}

// =========================================================================
// Parser state enum
// =========================================================================

const enum ParserState {
	Outside,
	InThinking,
	InText,
	InToolUse,
	InCode,
	InProgress,
}

// =========================================================================
// Prompt formatting functions
// =========================================================================

/**
 * Formats tool definitions into JSON string for injection into the user_prompt.
 * Uses the same format as the working fork: JSON array with name, description, parameters.
 */
export function formatToolDefinitionsForPrompt(tools: Array<{ function: { name: string; description: string; parameters?: object }; type: 'function' }>): string {
	if (!tools || tools.length === 0) {
		return '';
	}

	const serialized = tools.map(tool => ({
		name: tool.function.name,
		description: tool.function.description,
		parameters: tool.function.parameters ?? { type: 'object' },
	}));

	return JSON.stringify(serialized, null, 2);
}

/**
 * The system instruction that teaches the LLM how to use tools and format responses.
 *
 * CRITICAL: Matches the working fork's format exactly:
 * - ALL response content must be inside XML tags
 * - Tool calls use: <tool_use>{"name":"...","parameters":{...}}</tool_use>
 * - Text outside XML tags is silently discarded
 */
export function getToolCallingSystemPrompt(toolDefinitions: string): string {
	return `YOU HAVE ACCESS TO THE TOOLS LISTED BELOW. YOU MUST USE THEM.
When the user asks you to perform an action, you MUST invoke tools via <tool_use> tags.
NEVER describe steps in text — ALWAYS execute them via tool calls.
Format: <tool_use>{"name": "toolName", "parameters": {...}}</tool_use>

Available tools:
${toolDefinitions}`;
}

/**
 * Format reminder injected at the end of the serialized prompt to reinforce XML response rules.
 * Counteracts "lost in the middle" degradation in long conversations.
 */
export const FORMAT_REMINDER_INSTRUCTION =
	'[RESPONSE FORMAT REMINDER] Your ENTIRE response MUST use XML tags.\n' +
	'Valid tags: <thinking>, <text>, <tool_use>, <code>, <progress>.\n' +
	'Text outside XML tags is SILENTLY DISCARDED by the system.\n' +
	'Tool calls MUST use: <tool_use>{"name":"...","parameters":{...}}</tool_use>\n' +
	'If you have tools to call: respond with <thinking> + <tool_use> only (NO <text>).\n' +
	'If no tools to call: respond with <thinking> + <text>.';
