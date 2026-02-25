/*---------------------------------------------------------------------------------------------
 *  StackCode - OpenAI Compatible Response Parser
 *
 *  Parses LLM responses that are formatted as OpenAI Chat Completion API JSON
 *  objects (returned as strings in the Stackspot message field).
 *
 *  Handles:
 *  - Streaming responses (accumulating JSON chunks)
 *  - Complete responses (single JSON parse)
 *  - JSON escape sequences and nested JSON
 *  - Tool calls extraction from OpenAI format
 *  - Fallback to legacy XML parser if JSON parsing fails
 *--------------------------------------------------------------------------------------------*/

import { ParsedToolCall, StreamingToolCallParser, ToolCallParserEvent, ToolCallParserEventKind } from './toolCallParser';

/**
 * OpenAI Chat Completion response structure
 */
export interface OpenAIChatCompletionResponse {
	id?: string;
	object?: string;
	created?: number;
	model?: string;
	choices: OpenAIChatCompletionChoice[];
	usage?: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
	};
}

/**
 * Individual choice within a chat completion response
 */
export interface OpenAIChatCompletionChoice {
	index: number;
	message: OpenAIChatCompletionMessage;
	finish_reason: string | null;
}

/**
 * Message within a chat completion choice
 */
export interface OpenAIChatCompletionMessage {
	role: string;
	content: string | null;
	tool_calls?: OpenAIChatCompletionToolCall[];
	refusal?: string | null;
}

/**
 * Tool call within a chat completion message
 */
export interface OpenAIChatCompletionToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string; // JSON string
	};
}

/**
 * Delta structure for streaming responses
 */
export interface OpenAIChatCompletionDelta {
	role?: string;
	content?: string | null;
	tool_calls?: OpenAIChatCompletionToolCall[];
}

/**
 * Streaming choice structure
 */
export interface OpenAIStreamingChoice {
	index: number;
	delta: OpenAIChatCompletionDelta;
	finish_reason: string | null;
}

/**
 * Events emitted by the OpenAI-compatible streaming parser
 */
export const enum OpenAIParserEventKind {
	/** Plain text content */
	Text,
	/** A complete tool call has been parsed */
	ToolCallComplete,
	/** A tool call has started */
	ToolCallBegin,
	/** Tool call arguments are being streamed incrementally */
	ToolCallArgumentsDelta,
	/** Thinking/reasoning text (extracted from content) */
	Thinking,
	/** Error during parsing */
	Error,
}

export interface IOpenAITextEvent {
	kind: OpenAIParserEventKind.Text;
	text: string;
}

export interface IOpenAIToolCallCompleteEvent {
	kind: OpenAIParserEventKind.ToolCallComplete;
	toolCall: ParsedToolCall;
}

export interface IOpenAIToolCallBeginEvent {
	kind: OpenAIParserEventKind.ToolCallBegin;
	name: string;
	id: string;
}

export interface IOpenAIToolCallArgumentsDeltaEvent {
	kind: OpenAIParserEventKind.ToolCallArgumentsDelta;
	name: string;
	id: string;
	argumentsDelta: string;
}

export interface IOpenAIThinkingEvent {
	kind: OpenAIParserEventKind.Thinking;
	text: string;
}

export interface IOpenAIErrorEvent {
	kind: OpenAIParserEventKind.Error;
	error: string;
}

export type OpenAIParserEvent =
	| IOpenAITextEvent
	| IOpenAIToolCallCompleteEvent
	| IOpenAIToolCallBeginEvent
	| IOpenAIToolCallArgumentsDeltaEvent
	| IOpenAIThinkingEvent
	| IOpenAIErrorEvent;

/**
 * Result of parsing a complete response
 */
export interface ParsedOpenAIResponse {
	/** Text content for the user */
	text: string;
	/** Tool calls extracted from the response */
	toolCalls: ParsedToolCall[];
	/** Whether parsing was successful */
	success: boolean;
	/** Error message if parsing failed */
	error?: string;
	/** Whether we fell back to legacy XML parsing */
	usedFallback: boolean;
}

/**
 * Parses a JSON string that may contain escaped JSON (nested structure).
 * Handles cases like: "{\"key\": \"{\\\"nested\\\": true}\"}"
 */
function parseNestedJSON(jsonString: string): unknown {
	let result: unknown = jsonString;
	let attempts = 0;
	const maxAttempts = 3;

	while (attempts < maxAttempts) {
		try {
			if (typeof result === 'string') {
				result = JSON.parse(result);
			} else {
				break;
			}
		} catch {
			break;
		}
		attempts++;
	}

	return result;
}

/**
 * Extracts a single JSON object from text starting at `startPos`.
 * String-aware: ignores { and } inside JSON string values.
 * Returns the extracted string or null if not found.
 */
function extractJsonObjectAt(text: string, startPos: number): string | null {
	if (text[startPos] !== '{') {
		return null;
	}

	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = startPos; i < text.length; i++) {
		const ch = text[i];

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
				return text.slice(startPos, i + 1);
			}
		}
	}

	return null;
}

/**
 * Finds all top-level JSON objects in text using string-aware brace matching.
 * Handles multiple concatenated JSON objects (LLM multi-turn responses).
 */
function extractAllJsonObjects(text: string): string[] {
	const results: string[] = [];
	let searchFrom = 0;

	while (searchFrom < text.length) {
		const braceIndex = text.indexOf('{', searchFrom);
		if (braceIndex === -1) {
			break;
		}

		const jsonStr = extractJsonObjectAt(text, braceIndex);
		if (jsonStr) {
			results.push(jsonStr);
			searchFrom = braceIndex + jsonStr.length;
		} else {
			searchFrom = braceIndex + 1;
		}
	}

	return results;
}

/**
 * Validates if a parsed object matches OpenAI Chat Completion response structure
 */
function isValidOpenAIResponse(obj: unknown): obj is OpenAIChatCompletionResponse {
	if (!obj || typeof obj !== 'object') {
		return false;
	}

	const response = obj as Record<string, unknown>;

	// Must have choices array
	if (!Array.isArray(response.choices)) {
		return false;
	}

	// Each choice must have a message
	for (const choice of response.choices) {
		if (!choice || typeof choice !== 'object') {
			return false;
		}
		const c = choice as Record<string, unknown>;
		if (!c.message || typeof c.message !== 'object') {
			return false;
		}
	}

	return true;
}

/**
 * Extracts tool calls from an OpenAI response message
 */
function extractToolCallsFromMessage(message: OpenAIChatCompletionMessage): ParsedToolCall[] {
	if (!message.tool_calls || message.tool_calls.length === 0) {
		return [];
	}

	return message.tool_calls.map(tc => ({
		id: tc.id,
		name: tc.function.name,
		arguments: tc.function.arguments,
	}));
}

/**
 * Parses a complete OpenAI-style response string.
 * This is used for non-streaming responses.
 *
 * @param responseText - The raw response string from the LLM
 * @returns Parsed response with text and tool calls
 */
export function parseOpenAIResponse(responseText: string): ParsedOpenAIResponse {
	// Try to extract all JSON objects from text (string-aware, handles multi-JSON)
	const jsonStrings = extractAllJsonObjects(responseText);

	if (jsonStrings.length === 0) {
		// No JSON found, treat as plain text
		return {
			text: responseText.trim(),
			toolCalls: [],
			success: true,
			usedFallback: false,
		};
	}

	// Use first valid OpenAI response found
	for (const jsonText of jsonStrings) {
		let parsed: unknown;
		try {
			parsed = parseNestedJSON(jsonText);
		} catch {
			continue;
		}

		if (!isValidOpenAIResponse(parsed)) {
			continue;
		}

		const choice = parsed.choices[0];
		const message = choice.message;

		const text = message.content ?? '';
		const toolCalls = extractToolCallsFromMessage(message);

		return {
			text,
			toolCalls,
			success: true,
			usedFallback: false,
		};
	}

	// No valid OpenAI structure found, treat as plain text
	return {
		text: responseText.trim(),
		toolCalls: [],
		success: true,
		usedFallback: false,
	};
}

/**
 * Streaming parser for OpenAI-compatible responses.
 * Accumulates JSON chunks and emits events as content becomes available.
 */
export class StreamingOpenAIParser {
	private _buffer = '';
	private _parsedContent = '';
	private _parsedToolCalls: ParsedToolCall[] = [];
	private _toolCallIdCounter = 0;
	private _hasEmittedToolCalls = false;
	private _isComplete = false;

	/**
	 * Feed a chunk of text into the parser.
	 * Returns events detected in this chunk.
	 */
	public feed(chunk: string): OpenAIParserEvent[] {
		if (!chunk) {
			return [];
		}

		this._buffer += chunk;
		const events: OpenAIParserEvent[] = [];

		// Try to find all complete JSON objects in the buffer (string-aware, handles multi-JSON)
		const allJsonStrings = extractAllJsonObjects(this._buffer);

		for (const jsonStr of allJsonStrings) {
			try {
				const rawParsed = parseNestedJSON(jsonStr);
				if (!isValidOpenAIResponse(rawParsed)) {
					continue;
				}

				const choice = rawParsed.choices[0];
				const message = choice.message;

				// Handle content — suppress if tool_calls are present to avoid showing JSON in chat
				const hasToolCalls = !!(message.tool_calls?.length);
				if (message.content && message.content !== this._parsedContent && !hasToolCalls) {
					const newContent = message.content.slice(this._parsedContent.length);
					this._parsedContent = message.content;
					events.push({
						kind: OpenAIParserEventKind.Text,
						text: newContent,
					});
				}

				// Handle tool calls
				if (message.tool_calls && message.tool_calls.length > 0 && !this._hasEmittedToolCalls) {
					for (const tc of message.tool_calls) {
						const tcId = tc.id || `call_${Date.now()}_${this._toolCallIdCounter++}`;
						const tcArgs = typeof tc.function.arguments === 'string'
							? tc.function.arguments
							: JSON.stringify(tc.function.arguments);

						events.push({
							kind: OpenAIParserEventKind.ToolCallBegin,
							name: tc.function.name,
							id: tcId,
						});

						events.push({
							kind: OpenAIParserEventKind.ToolCallArgumentsDelta,
							name: tc.function.name,
							id: tcId,
							argumentsDelta: tcArgs,
						});

						events.push({
							kind: OpenAIParserEventKind.ToolCallComplete,
							toolCall: {
								id: tcId,
								name: tc.function.name,
								arguments: tcArgs,
							},
						});
					}
					this._hasEmittedToolCalls = true;
					this._parsedToolCalls = extractToolCallsFromMessage(message);
				}

			} catch { /* continue */ }
		}

		return events;
	}

	/**
	 * Flush any remaining buffered content.
	 * Call this when the stream ends.
	 */
	public flush(): OpenAIParserEvent[] {
		if (this._isComplete) {
			return [];
		}

		this._isComplete = true;
		const events: OpenAIParserEvent[] = [];

		try {
			// Try to extract ALL complete JSON objects (string-aware, handles multi-JSON)
			const allJsonStrings = extractAllJsonObjects(this._buffer);

			for (const jsonStr of allJsonStrings) {
				try {
					const rawParsed = parseNestedJSON(jsonStr);
					if (!isValidOpenAIResponse(rawParsed)) {
						continue;
					}

					const choice = rawParsed.choices[0];
					const message = choice.message;

					// Emit remaining content text — suppress if tool_calls are present to avoid showing JSON in chat
					const hasToolCalls = !!(message.tool_calls?.length);
					if (message.content && message.content.length > this._parsedContent.length && !hasToolCalls) {
						const newContent = message.content.slice(this._parsedContent.length);
						this._parsedContent = message.content;
						events.push({
							kind: OpenAIParserEventKind.Text,
							text: newContent,
						});
					}

					// Emit remaining tool calls
					if (message.tool_calls && message.tool_calls.length > 0 && !this._hasEmittedToolCalls) {
						for (const tc of message.tool_calls) {
							const tcArgs = typeof tc.function.arguments === 'string'
								? tc.function.arguments
								: JSON.stringify(tc.function.arguments);

							events.push({
								kind: OpenAIParserEventKind.ToolCallComplete,
								toolCall: {
									id: tc.id || `call_${Date.now()}_${this._toolCallIdCounter++}`,
									name: tc.function.name,
									arguments: tcArgs,
								},
							});
						}
						this._hasEmittedToolCalls = true;
					}
				} catch {
					// Skip unparseable JSON
				}
			}

			// If nothing was emitted (no valid OpenAI JSONs found):
			// Do NOT emit the buffer as Text if it looks like JSON — _isMalformedResponse
			// will detect plainTextParts is empty and trigger structured extraction.
			// Only emit as Text if the buffer is clearly regular narrative text (not JSON).
			if (events.length === 0 && !this._buffer.trim().startsWith('{')) {
				const text = this._buffer.trim();
				if (text) {
					events.push({
						kind: OpenAIParserEventKind.Text,
						text,
					});
				}
			}
		} catch (error) {
			events.push({
				kind: OpenAIParserEventKind.Error,
				error: error instanceof Error ? error.message : 'Unknown error during flush',
			});
		}

		return events;
	}

	/**
	 * Get the complete parsed tool calls
	 */
	public get toolCalls(): ParsedToolCall[] {
		return this._parsedToolCalls;
	}

	/**
	 * Get the accumulated text content
	 */
	public get text(): string {
		return this._parsedContent;
	}

	/**
	 * Reset the parser state
	 */
	public reset(): void {
		this._buffer = '';
		this._parsedContent = '';
		this._parsedToolCalls = [];
		this._toolCallIdCounter = 0;
		this._hasEmittedToolCalls = false;
		this._isComplete = false;
	}
}

/**
 * Unified parser that can handle both OpenAI JSON format and legacy XML format.
 * Automatically detects the format and uses the appropriate parser.
 */
export class UnifiedResponseParser {
	private _openaiParser = new StreamingOpenAIParser();
	private _xmlParser = new StreamingToolCallParser();
	private _usingXMLFallback = false;
	private _buffer = '';

	/**
	 * Feed a chunk into the parser.
	 * Automatically detects format and routes to appropriate parser.
	 */
	public feed(chunk: string): ToolCallParserEvent[] {
		if (!chunk) {
			return [];
		}

		this._buffer += chunk;

		// If we're already using XML fallback, continue with that
		if (this._usingXMLFallback) {
			return this._xmlParser.feed(chunk);
		}

		// Try to detect format based on content
		// OpenAI format starts with '{' or contains ```json
		// XML format starts with '<'
		const trimmed = this._buffer.trim();

		if (trimmed.startsWith('<') && !this._usingXMLFallback) {
			// Likely XML format, switch to XML parser
			this._usingXMLFallback = true;
			return this._xmlParser.feed(this._buffer);
		}

		// Try OpenAI parser
		const openaiEvents = this._openaiParser.feed(chunk);

		// If OpenAI parser didn't produce any events and buffer is growing,
		// check if we should fall back to XML
		if (openaiEvents.length === 0 && this._buffer.length > 100) {
			// Check if it's definitely not JSON
			if (!trimmed.startsWith('{') && !trimmed.startsWith('```')) {
				this._usingXMLFallback = true;
				return this._xmlParser.feed(this._buffer);
			}
		}

		// Convert OpenAI events to legacy ToolCallParserEvent format
		return this._convertOpenAIEvents(openaiEvents);
	}

	/**
	 * Flush remaining content
	 */
	public flush(): ToolCallParserEvent[] {
		if (this._usingXMLFallback) {
			return this._xmlParser.flush();
		}

		const openaiEvents = this._openaiParser.flush();
		return this._convertOpenAIEvents(openaiEvents);
	}

	/**
	 * Convert OpenAI parser events to legacy ToolCallParserEvent format
	 */
	private _convertOpenAIEvents(openaiEvents: OpenAIParserEvent[]): ToolCallParserEvent[] {
		const events: ToolCallParserEvent[] = [];

		for (const event of openaiEvents) {
			switch (event.kind) {
				case OpenAIParserEventKind.Text:
					events.push({
						kind: ToolCallParserEventKind.Text,
						text: event.text,
					});
					break;

				case OpenAIParserEventKind.ToolCallBegin:
					events.push({
						kind: ToolCallParserEventKind.ToolCallBegin,
						name: event.name,
						id: event.id,
					});
					break;

				case OpenAIParserEventKind.ToolCallArgumentsDelta:
					events.push({
						kind: ToolCallParserEventKind.ToolCallArgumentsDelta,
						name: event.name,
						id: event.id,
						argumentsDelta: event.argumentsDelta,
					});
					break;

				case OpenAIParserEventKind.ToolCallComplete:
					events.push({
						kind: ToolCallParserEventKind.ToolCallComplete,
						toolCall: event.toolCall,
					});
					break;

				case OpenAIParserEventKind.Thinking:
					events.push({
						kind: ToolCallParserEventKind.Thinking,
						text: event.text,
					});
					break;

				case OpenAIParserEventKind.Error:
					// On error, switch to XML fallback
					this._usingXMLFallback = true;
					return this._xmlParser.feed(this._buffer);
			}
		}

		return events;
	}

	/**
	 * Get whether we're using XML fallback
	 */
	public get usingFallback(): boolean {
		return this._usingXMLFallback;
	}

	/**
	 * Reset the parser
	 */
	public reset(): void {
		this._openaiParser.reset();
		this._xmlParser = new StreamingToolCallParser();
		this._usingXMLFallback = false;
		this._buffer = '';
	}
}
