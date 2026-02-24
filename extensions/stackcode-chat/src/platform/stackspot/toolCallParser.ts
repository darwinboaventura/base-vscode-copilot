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
	/** Tool call arguments are being streamed incrementally */
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
 * - <tool_use> content emits ToolCallBegin as soon as the tool name is detected,
 *   then streams ToolCallArgumentsDelta incrementally, and emits ToolCallComplete on close
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

	/** Whether the parser has entered any XML block (thinking, text, tool_use, etc.) */
	private _hasEnteredXmlBlock = false;
	/** Number of tool_use blocks that failed to parse */
	private _parseErrorCount = 0;

	// Incremental tool_use streaming state
	private _toolUseBeginEmitted = false;
	private _toolUseName = '';
	private _toolUseId = '';
	/** Number of bytes from _currentBuffer already emitted as ArgumentsDelta */
	private _toolUseDeltaOffset = 0;

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
						// If Begin was already emitted during streaming, reuse the same ID
						if (!this._toolUseBeginEmitted) {
							this._toolUseId = this._nextToolCallId();
							events.push({
								kind: ToolCallParserEventKind.ToolCallBegin,
								name: toolCall.name,
								id: this._toolUseId,
							});
						}
						// Emit any remaining arguments delta
						const remainingDelta = this._currentBuffer.substring(this._toolUseDeltaOffset);
						if (remainingDelta && this._toolUseBeginEmitted) {
							events.push({
								kind: ToolCallParserEventKind.ToolCallArgumentsDelta,
								name: this._toolUseName || toolCall.name,
								id: this._toolUseId,
								argumentsDelta: remainingDelta,
							});
						}
						events.push({
							kind: ToolCallParserEventKind.ToolCallComplete,
							toolCall: { name: toolCall.name, arguments: JSON.stringify(toolCall.parameters), id: this._toolUseId },
						});
						this._detectedToolCalls = true;
				} else {
					const preview = this._currentBuffer.trim().substring(0, 200);
					console.warn(`[StreamingToolCallParser] Failed to parse unclosed <tool_use> content on flush: ${preview}${this._currentBuffer.length > 200 ? '...' : ''}`);
					this._parseErrorCount++;
				}
				}
				this._resetToolUseState();
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

		// Content outside XML tags is NOT recovered as tool calls.
		// If the LLM did not use XML tags, this is a malformed response.
		// The caller (StackspotChatEndpoint) checks hasAnyXmlContent/hasParseErrors
		// and handles the retry with a correction message.
		if (this._outsideAccumulator.trim()) {
			// Emit outside text as plain Text so the caller can access the malformed content
			events.push({ kind: ToolCallParserEventKind.Text, text: this._outsideAccumulator });
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

	/**
	 * Whether the parser encountered any valid XML tags in the response.
	 * When false after flush(), the LLM response contained no XML structure at all.
	 */
	public get hasAnyXmlContent(): boolean {
		return this._hasEnteredXmlBlock;
	}

	/**
	 * Whether the parser encountered any tool_use blocks that failed to parse.
	 * This indicates the LLM used XML tags but produced invalid JSON inside them.
	 */
	public get hasParseErrors(): boolean {
		return this._parseErrorCount > 0;
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

		this._hasEnteredXmlBlock = true;
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
	 * Incrementally processes tool_use content:
	 * 1. Emits ToolCallBegin as soon as the tool name is detected
	 * 2. Emits ToolCallArgumentsDelta for each new chunk of content
	 * 3. Emits ToolCallComplete when </tool_use> closes
	 *
	 * This keeps the progress spinner active throughout tool call generation.
	 */
	private _consumeToolUse(events: ToolCallParserEvent[]): boolean {
		const pending = this._inputBuffer.join('');
		const closeTag = '</tool_use>';
		const closeIndex = pending.indexOf(closeTag);

		if (closeIndex === -1) {
			// Closing tag not found — accumulate what's safe (keep guard for partial close tag)
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

			// Try to detect tool name and emit Begin early
			this._tryEmitToolUseBegin(events);

			// Emit incremental argument deltas if Begin was already emitted
			this._emitToolUseDelta(events);

			return false;
		}

		// Closing tag found — finalize
		this._currentBuffer += pending.substring(0, closeIndex);
		const remainder = pending.substring(closeIndex + closeTag.length);
		this._inputBuffer.length = 0;
		if (remainder) {
			this._inputBuffer.push(remainder);
		}

		// Ensure Begin was emitted (might not have been if name came in the final chunk)
		this._tryEmitToolUseBegin(events);

		// Emit any remaining delta
		this._emitToolUseDelta(events);

		// Parse full content and emit Complete
		const rawContent = this._currentBuffer;
		const payload = this._safeParseToolUse(rawContent);

		if (payload) {
			// If Begin was never emitted (e.g., name extraction failed during streaming
			// but full parse succeeds), emit it now before Complete
			if (!this._toolUseBeginEmitted) {
				this._toolUseId = this._nextToolCallId();
				this._toolUseName = payload.name;
				events.push({
					kind: ToolCallParserEventKind.ToolCallBegin,
					name: payload.name,
					id: this._toolUseId,
				});
				this._toolUseBeginEmitted = true;
			}

			events.push({
				kind: ToolCallParserEventKind.ToolCallComplete,
				toolCall: {
					name: payload.name,
					arguments: JSON.stringify(payload.parameters),
					id: this._toolUseId,
				},
			});
			this._detectedToolCalls = true;
		} else if (rawContent.trim()) {
			// Log a warning so failed tool_use parsing is never silent.
			// Truncate to avoid flooding logs with large payloads.
			const preview = rawContent.trim().substring(0, 200);
			console.warn(`[StreamingToolCallParser] Failed to parse <tool_use> content: ${preview}${rawContent.length > 200 ? '...' : ''}`);
			this._parseErrorCount++;
		}

		this._resetToolUseState();
		this._resetState();
		return true;
	}

	/**
	 * Tries to extract the tool name from the accumulated _currentBuffer.
	 * When found, emits ToolCallBegin and sets _toolUseBeginEmitted = true.
	 *
	 * The JSON format is: {"name":"tool_name","parameters":{...}}
	 * We look for the pattern "name" followed by a colon and a quoted string.
	 */
	private _tryEmitToolUseBegin(events: ToolCallParserEvent[]): void {
		if (this._toolUseBeginEmitted) {
			return;
		}

		const name = this._extractToolName(this._currentBuffer);
		if (!name) {
			return;
		}

		this._toolUseId = this._nextToolCallId();
		this._toolUseName = name;
		this._toolUseBeginEmitted = true;
		// Mark the current buffer position so we start deltas from here
		this._toolUseDeltaOffset = this._currentBuffer.length;

		events.push({
			kind: ToolCallParserEventKind.ToolCallBegin,
			name,
			id: this._toolUseId,
		});
	}

	/**
	 * Emits any new content in _currentBuffer as ToolCallArgumentsDelta.
	 * Only emits after ToolCallBegin has been sent.
	 */
	private _emitToolUseDelta(events: ToolCallParserEvent[]): void {
		if (!this._toolUseBeginEmitted) {
			return;
		}

		const newContent = this._currentBuffer.substring(this._toolUseDeltaOffset);
		if (!newContent) {
			return;
		}

		this._toolUseDeltaOffset = this._currentBuffer.length;
		events.push({
			kind: ToolCallParserEventKind.ToolCallArgumentsDelta,
			name: this._toolUseName,
			id: this._toolUseId,
			argumentsDelta: newContent,
		});
	}

	/**
	 * Extracts the tool name from a partial JSON buffer.
	 * Looks for the pattern: "name" : "value"
	 * Returns the value if found and valid, undefined otherwise.
	 */
	private _extractToolName(buffer: string): string | undefined {
		// Match "name" followed by optional whitespace, colon, optional whitespace, and a quoted string
		const match = buffer.match(/"name"\s*:\s*"([^"]+)"/);
		if (!match) {
			return undefined;
		}

		const name = match[1].trim();
		// Validate tool name: must be alphanumeric with underscores, hyphens, dots, slashes
		if (!name || !/^[a-zA-Z0-9_\-./]+$/.test(name)) {
			return undefined;
		}

		return name;
	}

	/**
	 * Resets the incremental tool_use streaming state.
	 */
	private _resetToolUseState(): void {
		this._toolUseBeginEmitted = false;
		this._toolUseName = '';
		this._toolUseId = '';
		this._toolUseDeltaOffset = 0;
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
