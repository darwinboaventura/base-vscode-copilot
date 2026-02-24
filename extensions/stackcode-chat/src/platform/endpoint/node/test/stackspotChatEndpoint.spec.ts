/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { beforeEach, describe, expect, it } from 'vitest';
import { IInstantiationService } from '../../../../util/vs/platform/instantiation/common/instantiation';
import { IChatMLFetcher } from '../../../chat/common/chatMLFetcher';
import { ChatLocation } from '../../../chat/common/commonTypes';
import { DefaultsOnlyConfigurationService } from '../../../configuration/common/defaultsOnlyConfigurationService';
import { InMemoryConfigurationService } from '../../../configuration/test/common/inMemoryConfigurationService';
import { IChatModelInformation } from '../../../endpoint/common/endpointProvider';
import { IDomainService } from '../../../endpoint/common/domainService';
import { ILogService } from '../../../log/common/logService';
import { ICreateEndpointBodyOptions } from '../../../networking/common/networking';
import { NullExperimentationService } from '../../../telemetry/common/nullExperimentationService';
import { TelemetryData } from '../../../telemetry/common/telemetryData';
import { ITokenizerProvider } from '../../../tokenizer/node/tokenizer';
import { INLINE_FORMAT_REMINDER, StreamingToolCallParser } from '../../../stackspot/toolCallParser';
import { StackspotAuthService } from '../../../stackspot/auth';
import { StackspotChatEndpoint } from '../stackspotChatEndpoint';
import { TestLogService } from '../../../testing/common/testLogService';

// ── Helpers ──────────────────────────────────────────────────────────────────

const createModelMetadata = (): IChatModelInformation => ({
	id: 'stackspot-test',
	name: 'StackSpot Test Model',
	version: '1.0',
	model_picker_enabled: true,
	is_chat_default: true,
	is_chat_fallback: false,
	capabilities: {
		type: 'chat',
		family: 'stackspot',
		tokenizer: 'o200k_base' as any,
		supports: {
			parallel_tool_calls: false,
			streaming: true,
			tool_calls: true,
			vision: false,
			prediction: false,
			thinking: false,
		},
		limits: {
			max_prompt_tokens: 128000,
			max_output_tokens: 4096,
			max_context_window_tokens: 128000,
		},
	},
});

const createMockServices = () => ({
	domainService: {} as IDomainService,
	chatMLFetcher: {} as IChatMLFetcher,
	tokenizerProvider: {} as ITokenizerProvider,
	instantiationService: {} as IInstantiationService,
	configurationService: new InMemoryConfigurationService(new DefaultsOnlyConfigurationService()),
	experimentationService: new NullExperimentationService(),
	logService: new TestLogService(),
	stackspotAuth: new StackspotAuthService(),
});

function createEndpoint(services: ReturnType<typeof createMockServices>): StackspotChatEndpoint {
	return new StackspotChatEndpoint(
		createModelMetadata(),
		services.stackspotAuth,
		'test-agent-id',
		services.domainService,
		services.chatMLFetcher,
		services.tokenizerProvider,
		services.instantiationService,
		services.configurationService,
		services.experimentationService,
		services.logService,
	);
}

function createUserMessage(text: string): Raw.ChatMessage {
	return {
		role: Raw.ChatRole.User,
		content: [{ type: Raw.ChatCompletionContentPartKind.Text, text }],
	};
}

function createSystemMessage(text: string): Raw.ChatMessage {
	return {
		role: Raw.ChatRole.System,
		content: [{ type: Raw.ChatCompletionContentPartKind.Text, text }],
	};
}

function createAssistantMessage(text: string, toolCalls?: Raw.ChatMessageToolCall[]): Raw.ChatMessage {
	const msg: Raw.AssistantChatMessage = {
		role: Raw.ChatRole.Assistant,
		content: [{ type: Raw.ChatCompletionContentPartKind.Text, text }],
	};
	if (toolCalls) {
		msg.toolCalls = toolCalls;
	}
	return msg;
}

function createToolMessage(toolCallId: string, text: string): Raw.ChatMessage {
	return {
		role: Raw.ChatRole.Tool,
		toolCallId,
		content: [{ type: Raw.ChatCompletionContentPartKind.Text, text }],
	} as Raw.ToolChatMessage;
}

function createTestOptions(messages: Raw.ChatMessage[], tools?: any[]): ICreateEndpointBodyOptions {
	return {
		debugName: 'test',
		messages,
		requestId: 'test-req-123',
		postOptions: tools ? { tools } : {},
		finishedCb: undefined,
		location: ChatLocation.Panel as any,
	};
}

function createDummyTool(name: string): any {
	return {
		type: 'function',
		function: {
			name,
			description: `Test tool ${name}`,
			parameters: {
				type: 'object',
				properties: {
					arg1: { type: 'string', description: 'test arg' },
				},
				required: ['arg1'],
			},
		},
	};
}

/**
 * Extracts the user_prompt string from the endpoint body returned by createRequestBody().
 */
function getUserPrompt(endpoint: StackspotChatEndpoint, options: ICreateEndpointBodyOptions): string {
	const body = endpoint.createRequestBody(options);
	return (body as any).user_prompt;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('StackspotChatEndpoint — Malformed response improvements', () => {
	let services: ReturnType<typeof createMockServices>;
	let endpoint: StackspotChatEndpoint;

	beforeEach(() => {
		services = createMockServices();
		endpoint = createEndpoint(services);
	});

	// ────────────────────────────────────────────────────────────────────────
	// P1: Sandwich Prompting
	// ────────────────────────────────────────────────────────────────────────
	describe('P1: Sandwich prompting', () => {
		it('injects INLINE_FORMAT_REMINDER before the last <user> message when history has >= 4 parts and tools exist', () => {
			const messages: Raw.ChatMessage[] = [
				createSystemMessage('You are a helpful assistant.'),
				createUserMessage('First user message'),
				createAssistantMessage('First assistant reply'),
				createUserMessage('Second user message'),
				createAssistantMessage('Second assistant reply'),
				createUserMessage('Third user message'),
			];
			const tools = [createDummyTool('test_tool')];

			const prompt = getUserPrompt(endpoint, createTestOptions(messages, tools));

			// The reminder should appear in the prompt
			expect(prompt).toContain(INLINE_FORMAT_REMINDER);

			// The reminder should appear BEFORE the last <user> block
			const reminderIdx = prompt.indexOf(INLINE_FORMAT_REMINDER);
			const lastUserIdx = prompt.lastIndexOf('<user>');
			expect(reminderIdx).toBeLessThan(lastUserIdx);
			expect(reminderIdx).toBeGreaterThan(0);
		});

		it('does NOT inject INLINE_FORMAT_REMINDER when history has fewer than 4 parts', () => {
			const messages: Raw.ChatMessage[] = [
				createSystemMessage('You are helpful.'),
				createUserMessage('Hello'),
				createAssistantMessage('Hi!'),
			];
			const tools = [createDummyTool('test_tool')];

			const prompt = getUserPrompt(endpoint, createTestOptions(messages, tools));

			// With only 2 history parts (user + assistant), no sandwich prompt
			expect(prompt).not.toContain(INLINE_FORMAT_REMINDER);
		});

		it('does NOT inject INLINE_FORMAT_REMINDER when no tools are present', () => {
			const messages: Raw.ChatMessage[] = [
				createSystemMessage('You are helpful.'),
				createUserMessage('First message'),
				createAssistantMessage('Reply'),
				createUserMessage('Second message'),
				createAssistantMessage('Reply 2'),
				createUserMessage('Third message'),
			];

			// No tools
			const prompt = getUserPrompt(endpoint, createTestOptions(messages));

			expect(prompt).not.toContain(INLINE_FORMAT_REMINDER);
		});

		it('does NOT inject INLINE_FORMAT_REMINDER before the first <user> (lastUserIdx must be > 0)', () => {
			// Only one user message in history — lastUserIdx = 0, so splice shouldn't happen
			const messages: Raw.ChatMessage[] = [
				createSystemMessage('System prompt.'),
				createUserMessage('Only user message'),
			];
			const tools = [createDummyTool('test_tool')];

			const prompt = getUserPrompt(endpoint, createTestOptions(messages, tools));

			// Only 1 history part → < 4 threshold, so no reminder
			expect(prompt).not.toContain(INLINE_FORMAT_REMINDER);
		});
	});

	// ────────────────────────────────────────────────────────────────────────
	// P3: Improved narrative detection
	// ────────────────────────────────────────────────────────────────────────
	describe('P3: Improved narrative detection', () => {
		function callIsMalformedResponse(
			ep: StackspotChatEndpoint,
			parser: StreamingToolCallParser,
			allTokens: string[],
		): boolean {
			return (ep as any)._isMalformedResponse(parser, allTokens, 'test', services.logService);
		}

		it('detects short narrative text as malformed (no XML, no JSON, < 200 chars)', () => {
			const parser = new StreamingToolCallParser();
			// Feed nothing to the parser — hasAnyXmlContent = false
			const tokens = ["I'll help you with that. Let me navigate to the application."];

			const result = callIsMalformedResponse(endpoint, parser, tokens);

			expect(result).toBe(true);
		});

		it('detects long non-XML text with JSON-like content as malformed', () => {
			const parser = new StreamingToolCallParser();
			const longText = '{"name":"browser_navigate","parameters":{"url":"http://localhost:3000"}} some extra text that makes it long enough to exceed the 200 char limit so it does not count as a narrative response';
			const tokens = [longText];

			const result = callIsMalformedResponse(endpoint, parser, tokens);

			expect(result).toBe(true);
		});

		it('returns false when parser has valid XML content', () => {
			const parser = new StreamingToolCallParser();
			// Feed valid XML content
			parser.feed('<thinking>I will navigate to the app.</thinking>');
			parser.flush();

			const tokens = ['<thinking>I will navigate to the app.</thinking>'];

			const result = callIsMalformedResponse(endpoint, parser, tokens);

			expect(result).toBe(false);
		});

		it('returns false for empty response', () => {
			const parser = new StreamingToolCallParser();

			const result = callIsMalformedResponse(endpoint, parser, []);

			expect(result).toBe(false);
		});

		it('returns true when XML content has parse errors', () => {
			const parser = new StreamingToolCallParser();
			// Feed XML with a tool_use that has invalid JSON
			parser.feed('<tool_use>this is not valid JSON</tool_use>');
			parser.flush();

			const tokens = ['<tool_use>this is not valid JSON</tool_use>'];

			const result = callIsMalformedResponse(endpoint, parser, tokens);

			expect(result).toBe(true);
		});

		it('distinguishes narrative text from JSON text in log messages', () => {
			const logMessages: string[] = [];
			const mockLog: ILogService = {
				...services.logService,
				warn: (msg: string) => { logMessages.push(msg); },
			} as any;

			const parser = new StreamingToolCallParser();
			const tokens = ["Sure! I'll do that for you."];

			(endpoint as any)._isMalformedResponse(parser, tokens, 'test', mockLog);

			expect(logMessages.length).toBe(1);
			expect(logMessages[0]).toContain('short narrative text');
			expect(logMessages[0]).toContain('chars');
		});

		it('logs generic message for non-narrative non-XML responses', () => {
			const logMessages: string[] = [];
			const mockLog: ILogService = {
				...services.logService,
				warn: (msg: string) => { logMessages.push(msg); },
			} as any;

			const parser = new StreamingToolCallParser();
			// Has { so it's not classified as narrative
			const tokens = ['{"name":"tool","parameters":{}}'];

			(endpoint as any)._isMalformedResponse(parser, tokens, 'test', mockLog);

			expect(logMessages.length).toBe(1);
			expect(logMessages[0]).toContain('NO XML tags');
			expect(logMessages[0]).not.toContain('short narrative text');
		});
	});

	// ────────────────────────────────────────────────────────────────────────
	// P4: History compression
	// ────────────────────────────────────────────────────────────────────────
	describe('P4: History compression', () => {
		/**
		 * Creates a conversation with large tool results that exceeds the 80KB limit.
		 */
		function createLargeConversation(toolResultSize: number, toolResultCount: number): Raw.ChatMessage[] {
			const messages: Raw.ChatMessage[] = [
				createSystemMessage('You are a helpful AI assistant.'),
			];

			for (let i = 0; i < toolResultCount; i++) {
				// User asks something
				messages.push(createUserMessage(`Do task ${i}`));

				// Assistant calls a tool
				const toolCallId = `call_${i}`;
				messages.push(createAssistantMessage('', [{
					type: 'function',
					id: toolCallId,
					function: { name: 'read_file', arguments: `{"path":"/file${i}.txt"}` },
				}]));

				// Tool result with large content
				const bigContent = 'x'.repeat(toolResultSize);
				messages.push(createToolMessage(toolCallId, bigContent));

				// Assistant reply
				messages.push(createAssistantMessage(`Done with task ${i}`));
			}

			// Final user message
			messages.push(createUserMessage('Now do the final task'));

			return messages;
		}

		it('truncates old tool results when total history exceeds 80KB', () => {
			// 15 tool results of 8KB each = ~120KB > 80KB threshold
			const messages = createLargeConversation(8 * 1024, 15);
			const tools = [createDummyTool('read_file')];

			const prompt = getUserPrompt(endpoint, createTestOptions(messages, tools));

			// Should contain truncation markers for old tool results
			expect(prompt).toContain('Tool result truncated for context management');

			// The most recent 5 tool results should NOT be truncated
			// (they should still contain the full 'xxxx...' content)
			const lastToolResults = prompt.match(/<tool_result[^>]*>[\s\S]*?<\/tool_result>/g);
			expect(lastToolResults).toBeTruthy();

			// Count how many tool results still have the full content
			const fullResults = lastToolResults!.filter(r => r.includes('xxxxxxx'));
			expect(fullResults.length).toBeGreaterThanOrEqual(5);
		});

		it('does NOT truncate when history is under 80KB', () => {
			// 5 tool results of 2KB each = ~10KB < 80KB threshold
			const messages = createLargeConversation(2 * 1024, 5);
			const tools = [createDummyTool('read_file')];

			const prompt = getUserPrompt(endpoint, createTestOptions(messages, tools));

			expect(prompt).not.toContain('Tool result truncated for context management');
		});

		it('does NOT truncate when no tools are present', () => {
			// Large history but no tools → no compression
			const messages = createLargeConversation(8 * 1024, 15);

			const prompt = getUserPrompt(endpoint, createTestOptions(messages));

			expect(prompt).not.toContain('Tool result truncated for context management');
		});

		it('preserves the most recent 5 tool results intact', () => {
			// 10 tool results of 10KB each
			const messages = createLargeConversation(10 * 1024, 10);
			const tools = [createDummyTool('read_file')];

			const prompt = getUserPrompt(endpoint, createTestOptions(messages, tools));

			// Extract tool results in order
			const toolResultMatches = [...prompt.matchAll(/<tool_result id="call_(\d+)"[^>]*>([\s\S]*?)<\/tool_result>/g)];
			expect(toolResultMatches.length).toBe(10);

			// The last 5 (call_5 through call_9) should have full content
			for (let i = 5; i <= 9; i++) {
				const match = toolResultMatches.find(m => m[1] === String(i));
				expect(match).toBeTruthy();
				expect(match![2]).toContain('xxxxxxx');
			}

			// At least some of the older ones (call_0 through call_4) should be truncated
			const truncatedOld = toolResultMatches
				.filter(m => parseInt(m[1]) < 5)
				.filter(m => m[2].includes('Tool result truncated'));
			expect(truncatedOld.length).toBeGreaterThan(0);
		});

		it('stops truncating once history is under 80KB', () => {
			// 8 tool results: make some very large and some small
			// This tests that truncation stops early once under threshold
			const messages: Raw.ChatMessage[] = [
				createSystemMessage('System prompt'),
			];

			for (let i = 0; i < 8; i++) {
				messages.push(createUserMessage(`Task ${i}`));
				const toolCallId = `call_${i}`;
				messages.push(createAssistantMessage('', [{
					type: 'function',
					id: toolCallId,
					function: { name: 'read_file', arguments: `{"path":"file${i}"}` },
				}]));
				// First 3 are large (20KB), rest are small (500 bytes)
				const content = i < 3 ? 'L'.repeat(20 * 1024) : 'S'.repeat(500);
				messages.push(createToolMessage(toolCallId, content));
				messages.push(createAssistantMessage(`Done ${i}`));
			}
			messages.push(createUserMessage('Final'));

			const tools = [createDummyTool('read_file')];
			const prompt = getUserPrompt(endpoint, createTestOptions(messages, tools));

			// The small tool results (indices 3-4) in the truncatable range
			// should NOT be truncated because they are < TOOL_RESULT_TRUNCATE_THRESHOLD
			// or because we may have already reached the target
			const toolResults = [...prompt.matchAll(/<tool_result id="call_(\d+)"[^>]*>([\s\S]*?)<\/tool_result>/g)];
			const smallTruncatable = toolResults
				.filter(m => parseInt(m[1]) >= 3 && parseInt(m[1]) <= 4)
				.filter(m => m[2].includes('Tool result truncated'));

			// Small results (500 chars) should be under the 500-char truncation threshold
			// so they should NOT be truncated
			expect(smallTruncatable.length).toBe(0);
		});

		it('preserves tool_result id and error attributes in truncated results', () => {
			const messages: Raw.ChatMessage[] = [
				createSystemMessage('System'),
			];

			// Create tool results that will be truncated
			for (let i = 0; i < 10; i++) {
				messages.push(createUserMessage(`Task ${i}`));
				const toolCallId = `call_unique_${i}`;
				messages.push(createAssistantMessage('', [{
					type: 'function',
					id: toolCallId,
					function: { name: 'tool', arguments: '{}' },
				}]));
				// Include "error" in some results to set isError=true
				const content = i === 2
					? 'error: something failed'.padEnd(10 * 1024, 'x')
					: 'success result'.padEnd(10 * 1024, 'x');
				messages.push(createToolMessage(toolCallId, content));
				messages.push(createAssistantMessage(`Done ${i}`));
			}
			messages.push(createUserMessage('Final'));

			const tools = [createDummyTool('tool')];
			const prompt = getUserPrompt(endpoint, createTestOptions(messages, tools));

			// The truncated entries should still have proper id and error attributes
			const truncatedResults = [...prompt.matchAll(/<tool_result id="([^"]*)" error="([^"]*)">\n\[Tool result truncated/g)];
			expect(truncatedResults.length).toBeGreaterThan(0);

			// All truncated results should have valid tool IDs
			for (const match of truncatedResults) {
				expect(match[1]).toMatch(/^call_unique_\d+$/);
				expect(match[2]).toMatch(/^(true|false)$/);
			}
		});
	});

	// ────────────────────────────────────────────────────────────────────────
	// Integration: Prompt structure
	// ────────────────────────────────────────────────────────────────────────
	describe('Prompt structure with tools', () => {
		it('wraps everything in <prompt> tags', () => {
			const messages = [
				createSystemMessage('System'),
				createUserMessage('Hello'),
			];
			const tools = [createDummyTool('test')];

			const prompt = getUserPrompt(endpoint, createTestOptions(messages, tools));

			expect(prompt.startsWith('<prompt>')).toBe(true);
			expect(prompt.endsWith('</prompt>')).toBe(true);
		});

		it('includes FORMAT_REMINDER_INSTRUCTION at the end when tools present', () => {
			const messages = [
				createSystemMessage('System'),
				createUserMessage('Hello'),
			];
			const tools = [createDummyTool('test')];

			const prompt = getUserPrompt(endpoint, createTestOptions(messages, tools));

			expect(prompt).toContain('[RESPONSE FORMAT REMINDER]');
			// Should be near the end (before </prompt>)
			const reminderIdx = prompt.indexOf('[RESPONSE FORMAT REMINDER]');
			const endIdx = prompt.indexOf('</prompt>');
			expect(reminderIdx).toBeLessThan(endIdx);
		});

		it('does NOT include FORMAT_REMINDER when no tools', () => {
			const messages = [
				createSystemMessage('System'),
				createUserMessage('Hello'),
			];

			const prompt = getUserPrompt(endpoint, createTestOptions(messages));

			expect(prompt).not.toContain('[RESPONSE FORMAT REMINDER]');
		});

		it('includes <tools> section when tools are present', () => {
			const messages = [
				createSystemMessage('System'),
				createUserMessage('Hello'),
			];
			const tools = [createDummyTool('my_tool')];

			const prompt = getUserPrompt(endpoint, createTestOptions(messages, tools));

			expect(prompt).toContain('<tools>');
			expect(prompt).toContain('</tools>');
			expect(prompt).toContain('my_tool');
		});

		it('includes <workspace> section when tools are present', () => {
			const messages = [
				createSystemMessage('System'),
				createUserMessage('Hello'),
			];
			const tools = [createDummyTool('test')];

			const prompt = getUserPrompt(endpoint, createTestOptions(messages, tools));

			expect(prompt).toContain('<workspace>');
			expect(prompt).toContain('absolute paths');
		});

		it('includes forced tool instruction when tool_choice specifies a function', () => {
			const messages = [
				createSystemMessage('System'),
				createUserMessage('Hello'),
			];
			const tools = [createDummyTool('forced_tool')];
			const options = createTestOptions(messages, tools);
			options.postOptions = {
				...options.postOptions,
				tools,
				tool_choice: { type: 'function', function: { name: 'forced_tool' } },
			};

			const prompt = getUserPrompt(endpoint, options);

			expect(prompt).toContain('MANDATORY');
			expect(prompt).toContain('"forced_tool"');
		});
	});
});

// ── Race Condition Fix Tests ─────────────────────────────────────────────────
// These tests verify the per-request context correlation mechanism that replaced
// the singleton _lastRequestTools / _lastRequestDebugName fields.
// The fix uses a Map keyed by requestId (from ICreateEndpointBodyOptions) and
// correlates via telemetryData.properties in processResponseFromChatEndpoint().

describe('StackspotChatEndpoint — Per-request context correlation (race condition fix)', () => {
	let services: ReturnType<typeof createMockServices>;
	let endpoint: StackspotChatEndpoint;

	beforeEach(() => {
		services = createMockServices();
		endpoint = createEndpoint(services);
	});

	/**
	 * Helper: access the private _resolveRequestContext method for testing.
	 */
	function resolveContext(telemetryData: TelemetryData) {
		return (endpoint as any)._resolveRequestContext(telemetryData);
	}

	/**
	 * Helper: access the private _requestContextMap for assertions.
	 */
	function getContextMap(): Map<string, any> {
		return (endpoint as any)._requestContextMap;
	}

	/**
	 * Helper: creates test options with a specific requestId and debugName.
	 */
	function createOptionsWithId(requestId: string, debugName: string, tools?: any[]): ICreateEndpointBodyOptions {
		return {
			debugName,
			messages: [createSystemMessage('System'), createUserMessage('Hello')],
			requestId,
			postOptions: tools ? { tools } : {},
			finishedCb: undefined,
			location: ChatLocation.Panel as any,
		};
	}

	// ────────────────────────────────────────────────────────────────────────
	// Basic correlation
	// ────────────────────────────────────────────────────────────────────────

	it('stores context in Map after createRequestBody and resolves by requestId', () => {
		const tools = [createDummyTool('tool1')];
		endpoint.createRequestBody(createOptionsWithId('req-1', 'agentPanel', tools));

		expect(getContextMap().size).toBe(1);

		// Simulate telemetryData with requestId property (direct match)
		const telemetry = TelemetryData.createAndMarkAsIssued({
			requestId: 'req-1',
			messageSource: 'agentPanel',
		});

		const ctx = resolveContext(telemetry);
		expect(ctx).toBeDefined();
		expect(ctx!.debugName).toBe('agentPanel');
		expect(ctx!.tools).toHaveLength(1);
		expect(ctx!.tools![0].function.name).toBe('tool1');

		// Context should be consumed (deleted)
		expect(getContextMap().size).toBe(0);
	});

	it('resolves by messageId when requestId is not present', () => {
		const tools = [createDummyTool('tool1')];
		endpoint.createRequestBody(createOptionsWithId('msg-42', 'agentPanel', tools));

		const telemetry = TelemetryData.createAndMarkAsIssued({
			messageId: 'msg-42',
			messageSource: 'agentPanel',
		});

		const ctx = resolveContext(telemetry);
		expect(ctx).toBeDefined();
		expect(ctx!.debugName).toBe('agentPanel');
		expect(ctx!.tools).toHaveLength(1);
	});

	it('resolves by messageSource (debugName) when requestId/messageId are missing', () => {
		const tools = [createDummyTool('tool1')];
		endpoint.createRequestBody(createOptionsWithId('req-999', 'agentPanel', tools));

		// No requestId, no messageId — only messageSource
		const telemetry = TelemetryData.createAndMarkAsIssued({
			messageSource: 'agentPanel',
		});

		const ctx = resolveContext(telemetry);
		expect(ctx).toBeDefined();
		expect(ctx!.debugName).toBe('agentPanel');
		expect(ctx!.tools).toHaveLength(1);
	});

	it('returns undefined and does not throw when no context is found', () => {
		const telemetry = TelemetryData.createAndMarkAsIssued({
			requestId: 'nonexistent',
			messageSource: 'nonexistent',
		});

		const ctx = resolveContext(telemetry);
		expect(ctx).toBeUndefined();
	});

	// ────────────────────────────────────────────────────────────────────────
	// Concurrent request scenarios (the race condition)
	// ────────────────────────────────────────────────────────────────────────

	it('isolates concurrent requests: agent (tools) and summary (no tools)', () => {
		const tools = [createDummyTool('read_file'), createDummyTool('write_file')];

		// Simulate the race: agent request first, summary request second
		endpoint.createRequestBody(createOptionsWithId('req-agent', 'agentPanel', tools));
		endpoint.createRequestBody(createOptionsWithId('req-summary', 'generateTitle'));

		expect(getContextMap().size).toBe(2);

		// Summary response arrives FIRST (no tools)
		const summaryTelemetry = TelemetryData.createAndMarkAsIssued({
			requestId: 'req-summary',
			messageSource: 'generateTitle',
		});
		const summaryCtx = resolveContext(summaryTelemetry);
		expect(summaryCtx).toBeDefined();
		expect(summaryCtx!.debugName).toBe('generateTitle');
		expect(summaryCtx!.tools).toBeUndefined();

		// Agent response arrives SECOND (has tools) — should still have correct context
		const agentTelemetry = TelemetryData.createAndMarkAsIssued({
			requestId: 'req-agent',
			messageSource: 'agentPanel',
		});
		const agentCtx = resolveContext(agentTelemetry);
		expect(agentCtx).toBeDefined();
		expect(agentCtx!.debugName).toBe('agentPanel');
		expect(agentCtx!.tools).toHaveLength(2);
		expect(agentCtx!.tools![0].function.name).toBe('read_file');

		// Both consumed
		expect(getContextMap().size).toBe(0);
	});

	it('handles the exact logged race scenario: [20342] agent + [20343] summary', () => {
		// Reproducing the exact scenario from the logs:
		// 13:51:26.781 — createRequestBody([20342]) for agent request → tools=61
		// 13:51:26.797 — createRequestBody([20343]) for summary → tools=0
		// 13:51:37.036 — processResponse([20342]) → should use tools=61 (NOT 0!)
		const tools = Array.from({ length: 61 }, (_, i) => createDummyTool(`tool_${i}`));

		endpoint.createRequestBody(createOptionsWithId('20342', 'agentPanel', tools));
		endpoint.createRequestBody(createOptionsWithId('20343', 'generateTitle'));

		// With old singleton code, _lastRequestTools would be undefined (from [20343])
		// With the fix, each request has isolated context

		// Process [20342] (agent with tools) — arrives AFTER [20343]'s createRequestBody
		const agentTelemetry = TelemetryData.createAndMarkAsIssued({
			messageId: '20342',
			messageSource: 'agentPanel',
		});
		const agentCtx = resolveContext(agentTelemetry);
		expect(agentCtx).toBeDefined();
		expect(agentCtx!.tools).toHaveLength(61);
		expect(agentCtx!.debugName).toBe('agentPanel');

		// Process [20343] (summary, no tools)
		const summaryTelemetry = TelemetryData.createAndMarkAsIssued({
			messageId: '20343',
			messageSource: 'generateTitle',
		});
		const summaryCtx = resolveContext(summaryTelemetry);
		expect(summaryCtx).toBeDefined();
		expect(summaryCtx!.tools).toBeUndefined();
	});

	it('handles multiple concurrent requests with same debugName via FIFO', () => {
		const tools1 = [createDummyTool('first_iteration_tool')];
		const tools2 = [createDummyTool('second_iteration_tool')];

		// Two agent requests (same debugName) — e.g. tool calling loop iterations
		endpoint.createRequestBody(createOptionsWithId('iter-1', 'agentPanel', tools1));
		endpoint.createRequestBody(createOptionsWithId('iter-2', 'agentPanel', tools2));

		// When resolved by messageSource only (no requestId), FIFO order is used
		const telemetry1 = TelemetryData.createAndMarkAsIssued({
			messageSource: 'agentPanel',
		});
		const ctx1 = resolveContext(telemetry1);
		expect(ctx1).toBeDefined();
		expect(ctx1!.tools![0].function.name).toBe('first_iteration_tool');

		const telemetry2 = TelemetryData.createAndMarkAsIssued({
			messageSource: 'agentPanel',
		});
		const ctx2 = resolveContext(telemetry2);
		expect(ctx2).toBeDefined();
		expect(ctx2!.tools![0].function.name).toBe('second_iteration_tool');
	});

	// ────────────────────────────────────────────────────────────────────────
	// Cleanup and edge cases
	// ────────────────────────────────────────────────────────────────────────

	it('cleans up secondary index when context is consumed by requestId', () => {
		const debugNameIndex: Map<string, string[]> = (endpoint as any)._debugNameToRequestIds;

		endpoint.createRequestBody(createOptionsWithId('req-x', 'agentPanel', [createDummyTool('t')]));
		expect(debugNameIndex.get('agentPanel')).toEqual(['req-x']);

		const telemetry = TelemetryData.createAndMarkAsIssued({ requestId: 'req-x' });
		resolveContext(telemetry);

		// Secondary index should also be cleaned up
		expect(debugNameIndex.has('agentPanel')).toBe(false);
	});

	it('stores context for requests without tools (tools=undefined)', () => {
		endpoint.createRequestBody(createOptionsWithId('req-notool', 'generateTitle'));

		const telemetry = TelemetryData.createAndMarkAsIssued({ requestId: 'req-notool' });
		const ctx = resolveContext(telemetry);

		expect(ctx).toBeDefined();
		expect(ctx!.debugName).toBe('generateTitle');
		expect(ctx!.tools).toBeUndefined();
	});

	it('does not leak memory: consumed entries are removed from Map', () => {
		for (let i = 0; i < 100; i++) {
			endpoint.createRequestBody(createOptionsWithId(`req-${i}`, 'agentPanel', [createDummyTool(`t${i}`)]));
		}
		expect(getContextMap().size).toBe(100);

		// Consume all
		for (let i = 0; i < 100; i++) {
			const telemetry = TelemetryData.createAndMarkAsIssued({ requestId: `req-${i}` });
			resolveContext(telemetry);
		}
		expect(getContextMap().size).toBe(0);
	});

	it('handles tool_choice=none: tools are suppressed (stored as undefined)', () => {
		const tools = [createDummyTool('suppressed_tool')];
		const options = createOptionsWithId('req-none', 'agentPanel', tools);
		options.postOptions = {
			...options.postOptions,
			tools,
			tool_choice: 'none',
		};

		endpoint.createRequestBody(options);

		const telemetry = TelemetryData.createAndMarkAsIssued({ requestId: 'req-none' });
		const ctx = resolveContext(telemetry);

		expect(ctx).toBeDefined();
		// tool_choice=none should have suppressed the tools
		expect(ctx!.tools).toBeUndefined();
	});
});
