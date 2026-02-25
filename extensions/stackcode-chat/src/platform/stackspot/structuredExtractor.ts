/*---------------------------------------------------------------------------------------------
 *  StackCode - Structured Extraction / Output Parser
 *
 *  Multi-layer fallback parser that extracts structured tool calls from
 *  unstructured/malformed LLM responses. Inspired by:
 *  - Instructor MD_JSON mode (regex code fence extraction + Zod validation)
 *  - Vercel AI SDK extractJsonMiddleware (code fence stripping + brace detection)
 *  - PydanticAI Prompted Output (schema injection + validation retry)
 *
 *  This module is the "rescue layer" between the XML streaming parser (Layer 1)
 *  and the retry mechanism (Layer 5). When the LLM ignores the XML format and
 *  responds with raw JSON, code fences, or narrative text mixed with JSON, the
 *  extractor attempts to recover valid tool calls before falling back to retry.
 *
 *  Extraction pipeline (stops at first layer that produces results):
 *    Layer 2: Code fence extraction (```json ... ```)
 *    Layer 3: Raw JSON brace-matching (find all top-level {...} objects)
 *    Layer 4: Text pattern extraction (narrative + embedded JSON)
 *
 *  Each extracted JSON object passes through:
 *    A. JSON cleanup (trailing commas, comments, single quotes)
 *    B. JSON.parse()
 *    C. Field normalization (name/tool/function, parameters/args/arguments)
 *    D. Zod schema validation
 *    E. ID generation
 *
 *  The downstream VS Code tool calling pipeline (toolCallingLoop.ts,
 *  toolsService.ts) handles name/schema validation and sends error feedback
 *  to the LLM. This extractor only needs to produce structurally valid
 *  ParsedToolCall objects — it does NOT validate tool names or argument schemas.
 *--------------------------------------------------------------------------------------------*/

import { z } from 'zod';
import type { ParsedToolCall } from './toolCallParser';

// =========================================================================
// Zod schema for tool call validation
// =========================================================================

/**
 * Minimal schema that a tool call object must satisfy after normalization.
 * The actual tool name and argument schema validation is handled downstream
 * by toolsService.validateToolInput() using AJV.
 */
const ToolCallObjectSchema = z.object({
	name: z.string().min(1).regex(/^[a-zA-Z0-9_\-./]+$/),
	parameters: z.record(z.unknown()).default({}),
});

/**
 * Aliases the LLM might use instead of "name" for the tool name field.
 * Ordered by likelihood based on common LLM output patterns.
 */
const NAME_ALIASES: readonly string[] = ['name', 'tool', 'function', 'tool_name', 'toolName', 'action'];

/**
 * Aliases the LLM might use instead of "parameters" for the arguments field.
 * Ordered by likelihood based on common LLM output patterns.
 */
const PARAMS_ALIASES: readonly string[] = ['parameters', 'params', 'args', 'arguments', 'input', 'properties'];

/**
 * Fields that are part of the tool call structure itself (not user parameters).
 * Used to detect "flat parameter" patterns where the LLM omits the parameters wrapper.
 */
const STRUCTURAL_FIELDS = new Set([...NAME_ALIASES, ...PARAMS_ALIASES, 'id', 'type']);

// =========================================================================
// Global counter for generating unique tool call IDs
// =========================================================================

let _extractionIdCounter = Date.now();

function nextToolCallId(): string {
	_extractionIdCounter += 1;
	return `tooluse-rescue-${_extractionIdCounter}`;
}

// =========================================================================
// Public API
// =========================================================================

/**
 * Attempts to extract tool calls from unstructured text using a multi-layer
 * fallback pipeline. Returns an array of valid ParsedToolCall objects, or
 * an empty array if no valid tool calls could be recovered.
 *
 * This is the main entry point for structured extraction.
 *
 * @param rawText The raw LLM response text (accumulated outside XML tags)
 * @returns Array of extracted and validated tool calls (may be empty)
 */
export function extractToolCalls(rawText: string): ParsedToolCall[] {
	if (!rawText || !rawText.trim()) {
		return [];
	}

	const trimmed = rawText.trim();

	// Quick check: does this text contain anything that looks like a tool call?
	// Avoid expensive parsing on responses that are clearly just narrative text.
	if (!_mightContainToolCall(trimmed)) {
		return [];
	}

	// Layer 2: Code fence extraction
	const fromFences = _extractFromCodeFences(trimmed);
	if (fromFences.length > 0) {
		return fromFences;
	}

	// Layer 3: Raw JSON brace-matching
	const fromRawJson = _extractFromRawJson(trimmed);
	if (fromRawJson.length > 0) {
		return fromRawJson;
	}

	// Layer 4: Text pattern extraction (array wrapper, etc.)
	const fromPatterns = _extractFromTextPatterns(trimmed);
	if (fromPatterns.length > 0) {
		return fromPatterns;
	}

	return [];
}

// =========================================================================
// Layer 2: Code fence extraction
// =========================================================================

/**
 * Extracts JSON tool calls from markdown code fences.
 *
 * Handles patterns like:
 *   ```json
 *   {"name": "read_file", "parameters": {"path": "/foo"}}
 *   ```
 *
 *   ```
 *   {"name": "read_file", "parameters": {"path": "/foo"}}
 *   ```
 *
 *   ~~~json
 *   {...}
 *   ~~~
 *
 * Also handles unclosed fences (LLM stopped before closing ```)
 * and multiple fences in the same response.
 */
function _extractFromCodeFences(text: string): ParsedToolCall[] {
	const results: ParsedToolCall[] = [];

	// Match both ``` and ~~~ fences, with optional language tag
	// Supports unclosed fences ($ matches end of string)
	const fenceRegex = /(?:```|~~~)(?:json|JSON)?\s*\n?([\s\S]*?)(?:\n?(?:```|~~~)|$)/g;

	let match: RegExpExecArray | null;
	while ((match = fenceRegex.exec(text)) !== null) {
		const content = match[1]?.trim();
		if (!content) {
			continue;
		}

		// The content inside a fence might be:
		// 1. A single JSON object
		// 2. An array of JSON objects
		// 3. Multiple JSON objects separated by whitespace/newlines
		const toolCalls = _parseJsonContent(content);
		results.push(...toolCalls);
	}

	return results;
}

// =========================================================================
// Layer 3: Raw JSON brace-matching
// =========================================================================

/**
 * Extracts JSON tool calls by finding all top-level JSON objects in the text
 * using brace-matching. Handles cases like:
 *
 *   {"name": "read_file", "parameters": {"path": "/foo"}}
 *
 *   I'll read the file for you. {"name": "read_file", "parameters": {"path": "/foo"}}
 *
 *   {"name": "tool1", ...} some text {"name": "tool2", ...}
 */
function _extractFromRawJson(text: string): ParsedToolCall[] {
	const jsonStrings = _extractAllJsonObjects(text);
	if (jsonStrings.length === 0) {
		return [];
	}

	const results: ParsedToolCall[] = [];
	for (const jsonStr of jsonStrings) {
		const cleaned = _cleanJson(jsonStr);
		const toolCalls = _tryParseAndNormalize(cleaned);
		results.push(...toolCalls);
	}

	return results;
}

// =========================================================================
// Layer 4: Text pattern extraction
// =========================================================================

/**
 * Handles edge cases that Layers 2-3 miss:
 *
 * 1. Array wrapper: [{"name": "tool1", ...}, {"name": "tool2", ...}]
 *    (brace-matching only finds {} not [])
 *
 * 2. The entire text is a single JSON object but with leading/trailing junk
 *    that prevented brace-matching from finding it
 */
function _extractFromTextPatterns(text: string): ParsedToolCall[] {
	// Try array wrapper: [...]
	const bracketStart = text.indexOf('[');
	if (bracketStart >= 0) {
		const arrayStr = _extractJsonArray(text, bracketStart);
		if (arrayStr) {
			const cleaned = _cleanJson(arrayStr);
			try {
				const parsed = JSON.parse(cleaned);
				if (Array.isArray(parsed)) {
					const results: ParsedToolCall[] = [];
					for (const item of parsed) {
						const normalized = _normalizeToolCall(item);
						if (normalized) {
							results.push(normalized);
						}
					}
					if (results.length > 0) {
						return results;
					}
				}
			} catch { /* fallthrough */ }
		}
	}

	return [];
}

// =========================================================================
// JSON Parsing & Normalization
// =========================================================================

/**
 * Parses a string that might contain one or more JSON tool call objects.
 * Handles single objects, arrays, and multiple objects separated by whitespace.
 */
function _parseJsonContent(content: string): ParsedToolCall[] {
	const cleaned = _cleanJson(content);

	// Try 1: Parse as a single JSON value (object or array)
	try {
		const parsed = JSON.parse(cleaned);
		if (Array.isArray(parsed)) {
			const results: ParsedToolCall[] = [];
			for (const item of parsed) {
				const normalized = _normalizeToolCall(item);
				if (normalized) {
					results.push(normalized);
				}
			}
			return results;
		}
		const normalized = _normalizeToolCall(parsed);
		if (normalized) {
			return [normalized];
		}
	} catch { /* fallthrough */ }

	// Try 2: Multiple JSON objects separated by whitespace/newlines
	const objects = _extractAllJsonObjects(cleaned);
	const results: ParsedToolCall[] = [];
	for (const objStr of objects) {
		const toolCalls = _tryParseAndNormalize(objStr);
		results.push(...toolCalls);
	}

	return results;
}

/**
 * Tries to parse a single JSON string and normalize it as a tool call.
 * Applies cleanup (trailing commas, etc.) and multiple parse attempts.
 */
function _tryParseAndNormalize(jsonStr: string): ParsedToolCall[] {
	// Attempt 1: Direct parse
	try {
		const parsed = JSON.parse(jsonStr);
		if (Array.isArray(parsed)) {
			const results: ParsedToolCall[] = [];
			for (const item of parsed) {
				const normalized = _normalizeToolCall(item);
				if (normalized) {
					results.push(normalized);
				}
			}
			return results;
		}
		const normalized = _normalizeToolCall(parsed);
		if (normalized) {
			return [normalized];
		}
	} catch { /* fallthrough */ }

	// Attempt 2: Clean and retry
	const cleaned = _cleanJson(jsonStr);
	if (cleaned !== jsonStr) {
		try {
			const parsed = JSON.parse(cleaned);
			const normalized = _normalizeToolCall(parsed);
			if (normalized) {
				return [normalized];
			}
		} catch { /* fallthrough */ }
	}

	return [];
}

/**
 * Normalizes a parsed JSON object into a ParsedToolCall.
 *
 * Handles multiple field naming conventions:
 * - name: name, tool, function, tool_name, toolName, action
 * - parameters: parameters, params, args, arguments, input, properties
 *
 * Also handles:
 * - String-encoded parameters (JSON string in arguments field)
 * - Flat parameters (fields at root level without parameters wrapper)
 * - Missing parameters (defaults to {})
 *
 * Returns null if the object doesn't look like a tool call.
 */
function _normalizeToolCall(obj: unknown): ParsedToolCall | null {
	if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
		return null;
	}

	const record = obj as Record<string, unknown>;

	// ── Extract tool name ───────────────────────────────────────────
	let name: string | undefined;
	for (const alias of NAME_ALIASES) {
		const candidate = record[alias];
		if (typeof candidate === 'string' && candidate.trim()) {
			name = candidate.trim();
			break;
		}
	}

	if (!name) {
		return null;
	}

	// ── Extract parameters ──────────────────────────────────────────
	let parameters: Record<string, unknown> | undefined;

	for (const alias of PARAMS_ALIASES) {
		const candidate = record[alias];
		if (candidate !== undefined && candidate !== null) {
			if (typeof candidate === 'string') {
				// Parameters might be a JSON string (e.g., from OpenAI-like format)
				try {
					const parsed = JSON.parse(candidate);
					if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
						parameters = parsed as Record<string, unknown>;
						break;
					}
				} catch {
					// Not valid JSON string — skip this alias
				}
			} else if (typeof candidate === 'object' && !Array.isArray(candidate)) {
				parameters = candidate as Record<string, unknown>;
				break;
			}
		}
	}

	// ── Flat parameters fallback ────────────────────────────────────
	// If no parameters field found, check if the LLM put parameters
	// at the root level alongside "name". For example:
	//   {"name": "read_file", "path": "/foo/bar.ts"}
	// becomes:
	//   {"name": "read_file", "parameters": {"path": "/foo/bar.ts"}}
	if (!parameters) {
		const extraFields: Record<string, unknown> = {};
		let hasExtras = false;
		for (const [key, value] of Object.entries(record)) {
			if (!STRUCTURAL_FIELDS.has(key)) {
				extraFields[key] = value;
				hasExtras = true;
			}
		}
		if (hasExtras) {
			parameters = extraFields;
		}
	}

	// ── Validate with Zod ───────────────────────────────────────────
	const validation = ToolCallObjectSchema.safeParse({
		name,
		parameters: parameters ?? {},
	});

	if (!validation.success) {
		return null;
	}

	// ── Build ParsedToolCall ────────────────────────────────────────
	return {
		name: validation.data.name,
		arguments: JSON.stringify(validation.data.parameters),
		id: nextToolCallId(),
	};
}

// =========================================================================
// JSON Cleanup
// =========================================================================

/**
 * Cleans up common JSON formatting issues that cause JSON.parse() to fail.
 *
 * Applied transforms (in order):
 * 1. Remove zero-width characters and BOM
 * 2. Remove single-line comments (// ...)
 * 3. Remove multi-line comments
 * 4. Remove trailing commas before } or ]
 * 5. Attempt single-quote to double-quote conversion (with care)
 */
function _cleanJson(raw: string): string {
	let result = raw;

	// 1. Remove zero-width characters and BOM
	result = result.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '');

	// 2. Remove single-line comments (only outside strings)
	result = _removeLineComments(result);

	// 3. Remove multi-line comments (only outside strings)
	result = result.replace(/\/\*[\s\S]*?\*\//g, '');

	// 4. Remove trailing commas: ,} → } and ,] → ]
	result = result.replace(/,\s*([\]}])/g, '$1');

	// 5. Single-quote to double-quote conversion
	// Only applies if the text uses single quotes consistently
	// (i.e., no double quotes present — to avoid corrupting strings)
	if (!result.includes('"') && result.includes("'")) {
		result = result.replace(/'/g, '"');
	}

	return result;
}

/**
 * Removes single-line comments (// ...) that are NOT inside JSON strings.
 * Uses a simple state machine to track string boundaries.
 */
function _removeLineComments(text: string): string {
	const lines = text.split('\n');
	const cleaned: string[] = [];

	for (const line of lines) {
		let inString = false;
		let escaped = false;
		let commentStart = -1;

		for (let i = 0; i < line.length; i++) {
			const ch = line[i];

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

			if (!inString && ch === '/' && i + 1 < line.length && line[i + 1] === '/') {
				commentStart = i;
				break;
			}
		}

		if (commentStart >= 0) {
			cleaned.push(line.substring(0, commentStart).trimEnd());
		} else {
			cleaned.push(line);
		}
	}

	return cleaned.join('\n');
}

// =========================================================================
// JSON Object/Array Extraction (Brace-matching)
// =========================================================================

/**
 * Extracts all top-level JSON objects from text using brace-matching.
 * Properly handles nested braces, strings, and escape sequences.
 *
 * For example, from:
 *   "I'll call these tools: {"name":"a",...} and then {"name":"b",...}"
 * Returns:
 *   ['{"name":"a",...}', '{"name":"b",...}']
 */
function _extractAllJsonObjects(text: string): string[] {
	const results: string[] = [];
	let searchFrom = 0;

	// Safety limit to prevent infinite loops on pathological input
	const MAX_EXTRACTIONS = 50;

	while (searchFrom < text.length && results.length < MAX_EXTRACTIONS) {
		const braceIndex = text.indexOf('{', searchFrom);
		if (braceIndex === -1) {
			break;
		}

		const jsonStr = _extractJsonObject(text, braceIndex);
		if (jsonStr) {
			results.push(jsonStr);
			searchFrom = braceIndex + jsonStr.length;
		} else {
			// No matching close brace — try next opening brace
			searchFrom = braceIndex + 1;
		}
	}

	return results;
}

/**
 * Extracts a complete JSON object string by counting matching braces.
 * Properly handles nested objects, strings with escaped quotes, and
 * escape sequences.
 *
 * Returns the substring from `start` to the matching `}`, inclusive.
 * Returns undefined if no matching close brace is found.
 */
function _extractJsonObject(raw: string, start: number): string | undefined {
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
 * Extracts a complete JSON array string by counting matching brackets.
 * Similar to _extractJsonObject but for [...] arrays.
 */
function _extractJsonArray(raw: string, start: number): string | undefined {
	if (raw[start] !== '[') {
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

		if (ch === '[') {
			depth++;
		} else if (ch === ']') {
			depth--;
			if (depth === 0) {
				return raw.substring(start, i + 1);
			}
		}
	}

	return undefined;
}

// =========================================================================
// Quick-check heuristic
// =========================================================================

/**
 * Quick heuristic to check if text MIGHT contain a tool call.
 * Avoids expensive parsing on clearly non-tool-call text like
 * "Sure, I can help you with that!" or simple narrative responses.
 *
 * Checks for presence of:
 * - { (required for any JSON object)
 * - At least one of the known name field aliases as a key pattern
 */
function _mightContainToolCall(text: string): boolean {
	if (!text.includes('{')) {
		return false;
	}

	// Look for any of the name aliases as a quoted key
	for (const alias of NAME_ALIASES) {
		// Match "name", 'name', or name: patterns
		if (text.includes(`"${alias}"`) || text.includes(`'${alias}'`)) {
			return true;
		}
	}

	// Also check for code fences that might contain tool calls
	if (text.includes('```')) {
		return true;
	}

	return false;
}
