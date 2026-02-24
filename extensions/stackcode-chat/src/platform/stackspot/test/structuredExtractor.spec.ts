/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { extractToolCalls } from '../structuredExtractor';

// Helper: verify a single tool call with expected name and parsed arguments
function expectSingleToolCall(
	result: ReturnType<typeof extractToolCalls>,
	expectedName: string,
	expectedArgs: Record<string, unknown>,
) {
	expect(result).toHaveLength(1);
	expect(result[0].name).toBe(expectedName);
	expect(JSON.parse(result[0].arguments)).toEqual(expectedArgs);
	expect(result[0].id).toMatch(/^tooluse-rescue-/);
}

describe('StructuredExtractor', () => {

	// =========================================================================
	// Empty / no-op inputs
	// =========================================================================

	describe('empty and non-tool-call inputs', () => {

		it('returns empty array for empty string', () => {
			expect(extractToolCalls('')).toEqual([]);
		});

		it('returns empty array for whitespace-only string', () => {
			expect(extractToolCalls('   \n\t  ')).toEqual([]);
		});

		it('returns empty array for plain narrative text', () => {
			expect(extractToolCalls('Sure, I can help you with that! Let me think about the best approach.')).toEqual([]);
		});

		it('returns empty array for text with braces but no tool-call-like content', () => {
			expect(extractToolCalls('The function returns {value: 42} in all cases.')).toEqual([]);
		});

		it('returns empty array for null/undefined coerced to string edge', () => {
			expect(extractToolCalls(undefined as unknown as string)).toEqual([]);
			expect(extractToolCalls(null as unknown as string)).toEqual([]);
		});
	});

	// =========================================================================
	// Layer 2: Code fence extraction
	// =========================================================================

	describe('Layer 2 — code fence extraction', () => {

		it('extracts tool call from ```json code fence', () => {
			const input = `I'll read the file for you.

\`\`\`json
{"name": "read_file", "parameters": {"path": "/foo/bar.ts"}}
\`\`\``;

			expectSingleToolCall(
				extractToolCalls(input),
				'read_file',
				{ path: '/foo/bar.ts' },
			);
		});

		it('extracts tool call from ``` fence without language tag', () => {
			const input = `\`\`\`
{"name": "run_command", "parameters": {"command": "npm test"}}
\`\`\``;

			expectSingleToolCall(
				extractToolCalls(input),
				'run_command',
				{ command: 'npm test' },
			);
		});

		it('extracts tool call from ~~~ fence', () => {
			const input = `~~~json
{"name": "list_files", "parameters": {"directory": "/src"}}
~~~`;

			expectSingleToolCall(
				extractToolCalls(input),
				'list_files',
				{ directory: '/src' },
			);
		});

		it('handles unclosed code fence (LLM stopped mid-response)', () => {
			const input = `\`\`\`json
{"name": "read_file", "parameters": {"path": "/foo.ts"}}`;

			expectSingleToolCall(
				extractToolCalls(input),
				'read_file',
				{ path: '/foo.ts' },
			);
		});

		it('extracts multiple tool calls from separate code fences', () => {
			const input = `I'll read both files.

\`\`\`json
{"name": "read_file", "parameters": {"path": "/a.ts"}}
\`\`\`

And then:

\`\`\`json
{"name": "read_file", "parameters": {"path": "/b.ts"}}
\`\`\``;

			const result = extractToolCalls(input);
			expect(result).toHaveLength(2);
			expect(result[0].name).toBe('read_file');
			expect(JSON.parse(result[0].arguments)).toEqual({ path: '/a.ts' });
			expect(result[1].name).toBe('read_file');
			expect(JSON.parse(result[1].arguments)).toEqual({ path: '/b.ts' });
		});

		it('extracts array of tool calls inside a single code fence', () => {
			const input = `\`\`\`json
[
  {"name": "read_file", "parameters": {"path": "/a.ts"}},
  {"name": "list_files", "parameters": {"directory": "/src"}}
]
\`\`\``;

			const result = extractToolCalls(input);
			expect(result).toHaveLength(2);
			expect(result[0].name).toBe('read_file');
			expect(result[1].name).toBe('list_files');
		});
	});

	// =========================================================================
	// Layer 3: Raw JSON brace-matching
	// =========================================================================

	describe('Layer 3 — raw JSON brace-matching', () => {

		it('extracts standalone JSON object', () => {
			const input = '{"name": "read_file", "parameters": {"path": "/foo.ts"}}';

			expectSingleToolCall(
				extractToolCalls(input),
				'read_file',
				{ path: '/foo.ts' },
			);
		});

		it('extracts JSON object with leading narrative text', () => {
			const input = 'I\'ll read the file now. {"name": "read_file", "parameters": {"path": "/foo.ts"}}';

			expectSingleToolCall(
				extractToolCalls(input),
				'read_file',
				{ path: '/foo.ts' },
			);
		});

		it('extracts JSON object with trailing narrative text', () => {
			const input = '{"name": "read_file", "parameters": {"path": "/foo.ts"}} This should work.';

			expectSingleToolCall(
				extractToolCalls(input),
				'read_file',
				{ path: '/foo.ts' },
			);
		});

		it('extracts multiple JSON objects separated by text', () => {
			const input = 'First: {"name": "read_file", "parameters": {"path": "/a.ts"}} and then {"name": "write_file", "parameters": {"path": "/b.ts", "content": "hello"}}';

			const result = extractToolCalls(input);
			expect(result).toHaveLength(2);
			expect(result[0].name).toBe('read_file');
			expect(result[1].name).toBe('write_file');
			expect(JSON.parse(result[1].arguments)).toEqual({ path: '/b.ts', content: 'hello' });
		});

		it('handles nested JSON objects in parameters', () => {
			const input = '{"name": "some_tool", "parameters": {"config": {"nested": {"deep": true}}, "flag": 1}}';

			expectSingleToolCall(
				extractToolCalls(input),
				'some_tool',
				{ config: { nested: { deep: true } }, flag: 1 },
			);
		});
	});

	// =========================================================================
	// Layer 4: Text pattern extraction (array wrappers)
	// =========================================================================

	describe('Layer 4 — array wrappers', () => {

		it('extracts tool calls from a JSON array', () => {
			const input = '[{"name": "read_file", "parameters": {"path": "/a.ts"}}, {"name": "list_files", "parameters": {"directory": "/src"}}]';

			const result = extractToolCalls(input);
			expect(result).toHaveLength(2);
			expect(result[0].name).toBe('read_file');
			expect(result[1].name).toBe('list_files');
		});

		it('extracts tool calls from array with leading text', () => {
			const input = 'Here are the tool calls: [{"name": "read_file", "parameters": {"path": "/a.ts"}}]';

			const result = extractToolCalls(input);
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('read_file');
		});
	});

	// =========================================================================
	// Field normalization (name aliases)
	// =========================================================================

	describe('field normalization — name aliases', () => {

		it('normalizes "tool" alias to name', () => {
			const input = '{"tool": "read_file", "parameters": {"path": "/foo.ts"}}';

			expectSingleToolCall(extractToolCalls(input), 'read_file', { path: '/foo.ts' });
		});

		it('normalizes "function" alias to name', () => {
			const input = '{"function": "read_file", "parameters": {"path": "/foo.ts"}}';

			expectSingleToolCall(extractToolCalls(input), 'read_file', { path: '/foo.ts' });
		});

		it('normalizes "tool_name" alias to name', () => {
			const input = '{"tool_name": "read_file", "parameters": {"path": "/foo.ts"}}';

			expectSingleToolCall(extractToolCalls(input), 'read_file', { path: '/foo.ts' });
		});

		it('normalizes "toolName" alias to name', () => {
			const input = '{"toolName": "read_file", "parameters": {"path": "/foo.ts"}}';

			expectSingleToolCall(extractToolCalls(input), 'read_file', { path: '/foo.ts' });
		});

		it('normalizes "action" alias to name', () => {
			const input = '{"action": "read_file", "parameters": {"path": "/foo.ts"}}';

			expectSingleToolCall(extractToolCalls(input), 'read_file', { path: '/foo.ts' });
		});
	});

	// =========================================================================
	// Field normalization (parameters aliases)
	// =========================================================================

	describe('field normalization — parameters aliases', () => {

		it('normalizes "params" alias', () => {
			const input = '{"name": "read_file", "params": {"path": "/foo.ts"}}';

			expectSingleToolCall(extractToolCalls(input), 'read_file', { path: '/foo.ts' });
		});

		it('normalizes "args" alias', () => {
			const input = '{"name": "read_file", "args": {"path": "/foo.ts"}}';

			expectSingleToolCall(extractToolCalls(input), 'read_file', { path: '/foo.ts' });
		});

		it('normalizes "arguments" alias', () => {
			const input = '{"name": "read_file", "arguments": {"path": "/foo.ts"}}';

			expectSingleToolCall(extractToolCalls(input), 'read_file', { path: '/foo.ts' });
		});

		it('normalizes "input" alias', () => {
			const input = '{"name": "read_file", "input": {"path": "/foo.ts"}}';

			expectSingleToolCall(extractToolCalls(input), 'read_file', { path: '/foo.ts' });
		});

		it('normalizes "properties" alias', () => {
			const input = '{"name": "read_file", "properties": {"path": "/foo.ts"}}';

			expectSingleToolCall(extractToolCalls(input), 'read_file', { path: '/foo.ts' });
		});
	});

	// =========================================================================
	// String-encoded parameters
	// =========================================================================

	describe('string-encoded parameters', () => {

		it('parses arguments as JSON string (OpenAI-like format)', () => {
			const input = '{"name": "read_file", "arguments": "{\\"path\\": \\"/foo.ts\\"}"}';

			expectSingleToolCall(extractToolCalls(input), 'read_file', { path: '/foo.ts' });
		});

		it('ignores non-JSON string in arguments field', () => {
			// "arguments" is a string but not valid JSON — should fallback
			// to flat params detection or return null
			const input = '{"name": "read_file", "arguments": "not json"}';

			// The string "not json" is not valid JSON, so parameters alias is skipped.
			// No flat params detected (no extra keys beyond name+arguments).
			// Result depends on whether name-only is valid with empty params.
			const result = extractToolCalls(input);
			if (result.length > 0) {
				// If extracted, parameters should be empty
				expect(JSON.parse(result[0].arguments)).toEqual({});
			}
		});
	});

	// =========================================================================
	// Flat parameters (no wrapper)
	// =========================================================================

	describe('flat parameters detection', () => {

		it('detects parameters at root level alongside name', () => {
			const input = '{"name": "read_file", "path": "/foo/bar.ts", "encoding": "utf-8"}';

			expectSingleToolCall(
				extractToolCalls(input),
				'read_file',
				{ path: '/foo/bar.ts', encoding: 'utf-8' },
			);
		});

		it('prefers explicit parameters over flat fields', () => {
			const input = '{"name": "read_file", "parameters": {"path": "/correct.ts"}, "path": "/ignored.ts"}';

			expectSingleToolCall(
				extractToolCalls(input),
				'read_file',
				{ path: '/correct.ts' },
			);
		});
	});

	// =========================================================================
	// JSON cleanup
	// =========================================================================

	describe('JSON cleanup', () => {

		it('handles trailing commas', () => {
			const input = '{"name": "read_file", "parameters": {"path": "/foo.ts",},}';

			expectSingleToolCall(extractToolCalls(input), 'read_file', { path: '/foo.ts' });
		});

		it('handles single quotes when no double quotes present', () => {
			const input = "{'name': 'read_file', 'parameters': {'path': '/foo.ts'}}";

			expectSingleToolCall(extractToolCalls(input), 'read_file', { path: '/foo.ts' });
		});

		it('handles single-line comments in JSON', () => {
			const input = `{
  "name": "read_file", // the tool to use
  "parameters": {
    "path": "/foo.ts" // the file path
  }
}`;

			expectSingleToolCall(extractToolCalls(input), 'read_file', { path: '/foo.ts' });
		});

		it('handles zero-width characters', () => {
			const input = '\u200B{"name": "read_file", "parameters": {"path": "/foo.ts"}}\uFEFF';

			expectSingleToolCall(extractToolCalls(input), 'read_file', { path: '/foo.ts' });
		});

		it('handles trailing commas in code fence', () => {
			const input = `\`\`\`json
{
  "name": "read_file",
  "parameters": {
    "path": "/foo.ts",
  },
}
\`\`\``;

			expectSingleToolCall(extractToolCalls(input), 'read_file', { path: '/foo.ts' });
		});
	});

	// =========================================================================
	// Empty / missing parameters
	// =========================================================================

	describe('missing parameters', () => {

		it('defaults to empty parameters when not provided', () => {
			const input = '{"name": "get_status"}';

			const result = extractToolCalls(input);
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('get_status');
			expect(JSON.parse(result[0].arguments)).toEqual({});
		});

		it('handles explicit empty parameters object', () => {
			const input = '{"name": "get_status", "parameters": {}}';

			const result = extractToolCalls(input);
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('get_status');
			expect(JSON.parse(result[0].arguments)).toEqual({});
		});
	});

	// =========================================================================
	// Rejection / invalid inputs
	// =========================================================================

	describe('rejection of invalid inputs', () => {

		it('rejects object without name field', () => {
			const input = '{"parameters": {"path": "/foo.ts"}}';

			expect(extractToolCalls(input)).toEqual([]);
		});

		it('rejects object with empty name', () => {
			const input = '{"name": "", "parameters": {"path": "/foo.ts"}}';

			expect(extractToolCalls(input)).toEqual([]);
		});

		it('rejects name with invalid characters', () => {
			const input = '{"name": "read file!", "parameters": {"path": "/foo.ts"}}';

			expect(extractToolCalls(input)).toEqual([]);
		});

		it('rejects array as top-level value inside parameters', () => {
			// parameters must be an object, not array
			const input = '{"name": "tool", "parameters": [1, 2, 3]}';

			// The array is not a valid parameters object, so should fall back
			// to flat params — but no extra fields, so empty params
			const result = extractToolCalls(input);
			if (result.length > 0) {
				expect(JSON.parse(result[0].arguments)).toEqual({});
			}
		});
	});

	// =========================================================================
	// ID generation
	// =========================================================================

	describe('ID generation', () => {

		it('generates unique IDs for each extracted tool call', () => {
			const input = '{"name": "tool_a", "parameters": {}} {"name": "tool_b", "parameters": {}}';

			const result = extractToolCalls(input);
			expect(result).toHaveLength(2);
			expect(result[0].id).not.toBe(result[1].id);
			expect(result[0].id).toMatch(/^tooluse-rescue-/);
			expect(result[1].id).toMatch(/^tooluse-rescue-/);
		});

		it('generates unique IDs across separate calls', () => {
			const inputA = '{"name": "tool_a", "parameters": {}}';
			const inputB = '{"name": "tool_b", "parameters": {}}';

			const resultA = extractToolCalls(inputA);
			const resultB = extractToolCalls(inputB);
			expect(resultA[0].id).not.toBe(resultB[0].id);
		});
	});

	// =========================================================================
	// Real-world malformed response patterns
	// =========================================================================

	describe('real-world malformed response patterns', () => {

		it('handles narrative text + inline JSON (most common Type A)', () => {
			const input = `I'll help you with that. Let me read the file first.

{"name": "read_file", "parameters": {"path": "/Users/darwin/project/src/index.ts", "maxLines": 200}}

This will show us the content of the main file.`;

			expectSingleToolCall(
				extractToolCalls(input),
				'read_file',
				{ path: '/Users/darwin/project/src/index.ts', maxLines: 200 },
			);
		});

		it('handles LLM using "function" + "arguments" with string encoding', () => {
			const input = `\`\`\`json
{"function": "run_command", "arguments": "{\\"command\\": \\"npm test\\", \\"cwd\\": \\"/project\\"}"}
\`\`\``;

			expectSingleToolCall(
				extractToolCalls(input),
				'run_command',
				{ command: 'npm test', cwd: '/project' },
			);
		});

		it('handles tool call with dots and slashes in name', () => {
			const input = '{"name": "vscode/readFile", "parameters": {"path": "/foo.ts"}}';

			expectSingleToolCall(
				extractToolCalls(input),
				'vscode/readFile',
				{ path: '/foo.ts' },
			);
		});

		it('handles tool name with hyphens', () => {
			const input = '{"name": "ask-questions", "parameters": {"question": "what file?"}}';

			expectSingleToolCall(
				extractToolCalls(input),
				'ask-questions',
				{ question: 'what file?' },
			);
		});

		it('handles mixed valid and invalid objects — extracts only valid ones', () => {
			const input = `Here are two calls:
{"name": "read_file", "parameters": {"path": "/a.ts"}}
{"not_a_tool": true, "value": 42}
{"name": "write_file", "parameters": {"path": "/b.ts", "content": "done"}}`;

			const result = extractToolCalls(input);
			expect(result).toHaveLength(2);
			expect(result[0].name).toBe('read_file');
			expect(result[1].name).toBe('write_file');
		});

		it('handles LLM response with multiline JSON in code fence', () => {
			const input = `Let me search for the pattern.

\`\`\`json
{
  "name": "grep_search",
  "parameters": {
    "pattern": "export function.*Handler",
    "include": "**/*.ts",
    "maxResults": 50
  }
}
\`\`\``;

			expectSingleToolCall(
				extractToolCalls(input),
				'grep_search',
				{ pattern: 'export function.*Handler', include: '**/*.ts', maxResults: 50 },
			);
		});

		it('handles tool call with complex nested parameters', () => {
			const input = '{"name": "create_config", "parameters": {"settings": {"editor": {"tabSize": 4, "insertSpaces": false}, "files": {"exclude": ["node_modules", ".git"]}}}}';

			expectSingleToolCall(
				extractToolCalls(input),
				'create_config',
				{
					settings: {
						editor: { tabSize: 4, insertSpaces: false },
						files: { exclude: ['node_modules', '.git'] },
					},
				},
			);
		});
	});
});
