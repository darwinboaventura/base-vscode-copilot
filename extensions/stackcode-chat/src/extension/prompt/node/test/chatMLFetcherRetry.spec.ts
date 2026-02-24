/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IAuthenticationService } from '../../../../platform/authentication/common/authentication';
import { CopilotToken } from '../../../../platform/authentication/common/copilotToken';
import { IFetchMLOptions } from '../../../../platform/chat/common/chatMLFetcher';
import { IChatQuotaService } from '../../../../platform/chat/common/chatQuotaService';
import { ChatFetchResponseType, ChatLocation } from '../../../../platform/chat/common/commonTypes';
import { IInteractionService } from '../../../../platform/chat/common/interactionService';
import { ConfigKey } from '../../../../platform/configuration/common/configurationService';
import { DefaultsOnlyConfigurationService } from '../../../../platform/configuration/common/defaultsOnlyConfigurationService';
import { InMemoryConfigurationService } from '../../../../platform/configuration/test/common/inMemoryConfigurationService';
import { ICAPIClientService } from '../../../../platform/endpoint/common/capiClient';
import { MockAuthenticationService } from '../../../../platform/ignore/node/test/mockAuthenticationService';
import { MockCAPIClientService } from '../../../../platform/ignore/node/test/mockCAPIClientService';
import { ElectronFetchErrorChromiumDetails, ILogService } from '../../../../platform/log/common/logService';
import { FinishedCallback } from '../../../../platform/networking/common/fetch';
import { IFetcherService, IHeaders, Response } from '../../../../platform/networking/common/fetcherService';
import { IChatEndpoint } from '../../../../platform/networking/common/networking';
import { FilterReason, FinishedCompletionReason } from '../../../../platform/networking/common/openai';
import { NullRequestLogger } from '../../../../platform/requestLogger/node/nullRequestLogger';
import { NullExperimentationService } from '../../../../platform/telemetry/common/nullExperimentationService';
import { NullTelemetryService } from '../../../../platform/telemetry/common/nullTelemetryService';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry';
import { TelemetryData } from '../../../../platform/telemetry/common/telemetryData';
import { TestLogService } from '../../../../platform/testing/common/testLogService';
import { CancellationToken, CancellationTokenSource } from '../../../../util/vs/base/common/cancellation';
import { Event } from '../../../../util/vs/base/common/event';
import { DisposableStore } from '../../../../util/vs/base/common/lifecycle';
import { IPowerService } from '../../../power/common/powerService';
import { ChatMLFetcherImpl } from '../chatMLFetcher';

describe('ChatMLFetcherImpl retry logic', () => {
	let disposables: DisposableStore;
	let fetcher: ChatMLFetcherImpl;
	let mockFetcherService: MockFetcherService;
	let configurationService: InMemoryConfigurationService;
	let cancellationTokenSource: CancellationTokenSource;
	let endpoint: IChatEndpoint;

	beforeEach(() => {
		disposables = new DisposableStore();
		cancellationTokenSource = disposables.add(new CancellationTokenSource());

		mockFetcherService = new MockFetcherService();
		configurationService = new InMemoryConfigurationService(new DefaultsOnlyConfigurationService());
		configurationService.setConfig(ConfigKey.TeamInternal.RetryServerErrorStatusCodes, '500,502');
		configurationService.setConfig(ConfigKey.TeamInternal.RetryNetworkErrors, true);

		const logService = new TestLogService();
		const telemetryService = new NullTelemetryService();
		const experimentationService = new NullExperimentationService();

		endpoint = createMockEndpoint();

		fetcher = new ChatMLFetcherImpl(
			mockFetcherService as unknown as IFetcherService,
			telemetryService,
			new NullRequestLogger(),
			logService,
			new TestAuthenticationService() as unknown as IAuthenticationService,
			createMockInteractionService(),
			createMockChatQuotaService(),
			new TestCAPIClientService() as unknown as ICAPIClientService,
			createMockConversationOptions(),
			configurationService,
			experimentationService,
			createMockPowerService(),
		);

		// Skip delays in tests for faster execution
		fetcher.connectivityCheckDelays = [0, 0, 0];
	});

	afterEach(() => {
		disposables.dispose();
	});

	function createBaseOpts(): IFetchMLOptions {
		return {
			debugName: 'test',
			messages: [{ role: Raw.ChatRole.User, content: [{ type: Raw.ChatCompletionContentPartKind.Text, text: 'Hello' }] }],
			endpoint,
			location: ChatLocation.Panel,
			enableRetryOnError: true,
			requestOptions: {},
			finishedCb: undefined,
		};
	}

	describe('server error retry with configured status codes', () => {
		it('retries on 500 status code when configured', async () => {
			// Order: 1) initial fetch → 500, 2) connectivity check → 200, 3) retry → success
			mockFetcherService.queueResponse(createErrorResponse(500, 'Internal Server Error'));
			mockFetcherService.queueResponse(createSuccessResponse('{}')); // connectivity check
			mockFetcherService.queueResponse(createSuccessResponse('Hello!')); // retry

			const result = await fetcher.fetchMany(createBaseOpts(), cancellationTokenSource.token);

			expect(result.type).toBe(ChatFetchResponseType.Success);
			expect(mockFetcherService.fetchCallCount).toBeGreaterThanOrEqual(2);
		});

		it('retries on 502 status code when configured', async () => {
			// Order: 1) initial fetch → 502, 2) connectivity check → 200, 3) retry → success
			mockFetcherService.queueResponse(createErrorResponse(502, 'Bad Gateway'));
			mockFetcherService.queueResponse(createSuccessResponse('{}')); // connectivity check
			mockFetcherService.queueResponse(createSuccessResponse('Success!')); // retry

			const result = await fetcher.fetchMany(createBaseOpts(), cancellationTokenSource.token);

			expect(result.type).toBe(ChatFetchResponseType.Success);
		});

		it('does not retry on 404 status code', async () => {
			mockFetcherService.queueResponse(createErrorResponse(404, 'Not Found'));

			const result = await fetcher.fetchMany(createBaseOpts(), cancellationTokenSource.token);

			expect(result.type).toBe(ChatFetchResponseType.NotFound);
			expect(mockFetcherService.fetchCallCount).toBe(1);
		});

		it('does not retry when enableRetryOnError is false', async () => {
			mockFetcherService.queueResponse(createErrorResponse(500, 'Internal Server Error'));

			const opts = createBaseOpts();
			opts.enableRetryOnError = false;
			const result = await fetcher.fetchMany(opts, cancellationTokenSource.token);

			expect(result.type).toBe(ChatFetchResponseType.Failed);
			expect(mockFetcherService.fetchCallCount).toBe(1);
		});

		it('respects custom status codes from configuration', async () => {
			// Configure to only retry on 503
			configurationService.setConfig(ConfigKey.TeamInternal.RetryServerErrorStatusCodes, '503');

			mockFetcherService.queueResponse(createErrorResponse(500, 'Internal Server Error'));

			const result = await fetcher.fetchMany(createBaseOpts(), cancellationTokenSource.token);

			// Should NOT retry because 500 is not in the configured list
			expect(result.type).toBe(ChatFetchResponseType.Failed);
			expect(mockFetcherService.fetchCallCount).toBe(1);
		});
	});

	describe('network error retry', () => {
		it('retries after connectivity check succeeds', async () => {
			configurationService.setConfig(ConfigKey.TeamInternal.RetryNetworkErrors, true);

			// Use ENOTFOUND instead of ECONNRESET - ECONNRESET triggers auto-retry in networking.ts
			// Order: 1) initial fetch → error, 2) connectivity check → 200, 3) retry → success
			mockFetcherService.queueError(createNetworkError('ENOTFOUND'));
			mockFetcherService.queueResponse(createSuccessResponse('{}')); // connectivity check
			mockFetcherService.queueResponse(createSuccessResponse('Success!')); // retry

			const result = await fetcher.fetchMany(createBaseOpts(), cancellationTokenSource.token);

			expect(result.type).toBe(ChatFetchResponseType.Success);
		});

		it('does not retry when RetryNetworkErrors is disabled', async () => {
			configurationService.setConfig(ConfigKey.TeamInternal.RetryNetworkErrors, false);

			// Use ENOTFOUND instead of ECONNRESET - ECONNRESET triggers auto-retry in networking.ts
			mockFetcherService.queueError(createNetworkError('ENOTFOUND'));

			const result = await fetcher.fetchMany(createBaseOpts(), cancellationTokenSource.token);

			expect(result.type).toBe(ChatFetchResponseType.NetworkError);
			expect(mockFetcherService.fetchCallCount).toBe(1);
		});
	});

	describe('status code parsing', () => {
		it('handles comma-separated status codes with spaces', async () => {
			configurationService.setConfig(ConfigKey.TeamInternal.RetryServerErrorStatusCodes, '500, 502 , 503');

			mockFetcherService.queueResponse(createErrorResponse(502, 'Bad Gateway'));
			mockFetcherService.queueResponse(createSuccessResponse('{}')); // connectivity check
			mockFetcherService.queueResponse(createSuccessResponse('Success!')); // retry

			const result = await fetcher.fetchMany(createBaseOpts(), cancellationTokenSource.token);

			expect(result.type).toBe(ChatFetchResponseType.Success);
		});

		it('handles invalid status codes gracefully', async () => {
			configurationService.setConfig(ConfigKey.TeamInternal.RetryServerErrorStatusCodes, '500,invalid,502');

			mockFetcherService.queueResponse(createErrorResponse(500, 'Internal Server Error'));
			mockFetcherService.queueResponse(createSuccessResponse('{}')); // connectivity check
			mockFetcherService.queueResponse(createSuccessResponse('Success!')); // retry

			// Should still retry on 500 even with invalid entry in config
			const result = await fetcher.fetchMany(createBaseOpts(), cancellationTokenSource.token);

			expect(result.type).toBe(ChatFetchResponseType.Success);
		});

		it('does not retry when configuration is empty string', async () => {
			configurationService.setConfig(ConfigKey.TeamInternal.RetryServerErrorStatusCodes, '');

			mockFetcherService.queueResponse(createErrorResponse(500, 'Internal Server Error'));

			const result = await fetcher.fetchMany(createBaseOpts(), cancellationTokenSource.token);

			// Empty config means no status codes to retry - should fail without retry
			expect(result.type).toBe(ChatFetchResponseType.Failed);
			expect(mockFetcherService.fetchCallCount).toBe(1);
		});

		it('does not retry when configuration contains only invalid values', async () => {
			configurationService.setConfig(ConfigKey.TeamInternal.RetryServerErrorStatusCodes, 'invalid,abc,xyz');

			mockFetcherService.queueResponse(createErrorResponse(500, 'Internal Server Error'));

			const result = await fetcher.fetchMany(createBaseOpts(), cancellationTokenSource.token);

			// All invalid means no valid status codes - should fail without retry
			expect(result.type).toBe(ChatFetchResponseType.Failed);
			expect(mockFetcherService.fetchCallCount).toBe(1);
		});
	});

	describe('connectivity check failure', () => {
		it('does not retry server error when connectivity check fails', async () => {
			configurationService.setConfig(ConfigKey.TeamInternal.RetryServerErrorStatusCodes, '500,502');

			// Order: 1) initial fetch → 500, 2) connectivity checks fail (3 attempts)
			mockFetcherService.queueResponse(createErrorResponse(500, 'Internal Server Error'));
			// Connectivity check retries 3 times (with 0ms delays in tests)
			mockFetcherService.queueError(createNetworkError('ENOTFOUND')); // 1st connectivity check
			mockFetcherService.queueError(createNetworkError('ENOTFOUND')); // 2nd connectivity check
			mockFetcherService.queueError(createNetworkError('ENOTFOUND')); // 3rd connectivity check

			const result = await fetcher.fetchMany(createBaseOpts(), cancellationTokenSource.token);

			// Should fail because connectivity check never succeeded
			expect(result.type).toBe(ChatFetchResponseType.Failed);
		});
	});

	describe('network process crash fallback to node-fetch', () => {
		it('falls back to node-fetch and retries when network process crashed and flag is enabled', async () => {
			configurationService.setConfig(ConfigKey.TeamInternal.RetryNetworkErrors, true);
			configurationService.setConfig(ConfigKey.TeamInternal.FallbackNodeFetchOnNetworkProcessCrash, true);

			// 1) initial fetch → network process crash error
			// 2) connectivity check via node-fetch → success
			// 3) retry via node-fetch → success
			mockFetcherService.queueError(createNetworkProcessCrashedError());
			mockFetcherService.queueResponse(createSuccessResponse('{}')); // connectivity check
			mockFetcherService.queueResponse(createSuccessResponse('Recovered!')); // retry

			const result = await fetcher.fetchMany(createBaseOpts(), cancellationTokenSource.token);

			expect(result.type).toBe(ChatFetchResponseType.Success);
			// Verify that connectivity check and retry used node-fetch
			const fetcherIds = mockFetcherService.fetcherIdsUsed;
			// fetcherIds[0] = initial request (default fetcher)
			// fetcherIds[1] = connectivity check (should be node-fetch)
			// fetcherIds[2] = retry request (should be node-fetch)
			expect(fetcherIds[1]).toBe('node-fetch');
			expect(fetcherIds[2]).toBe('node-fetch');
		});

		it('does NOT fall back to node-fetch when flag is disabled', async () => {
			configurationService.setConfig(ConfigKey.TeamInternal.RetryNetworkErrors, true);
			configurationService.setConfig(ConfigKey.TeamInternal.FallbackNodeFetchOnNetworkProcessCrash, false);

			// 1) initial fetch → network process crash error
			// 2-4) connectivity checks via default fetcher → all fail (dead network process)
			mockFetcherService.queueError(createNetworkProcessCrashedError());
			mockFetcherService.queueError(createNetworkError('ENOTFOUND')); // 1st connectivity check
			mockFetcherService.queueError(createNetworkError('ENOTFOUND')); // 2nd connectivity check
			mockFetcherService.queueError(createNetworkError('ENOTFOUND')); // 3rd connectivity check

			const result = await fetcher.fetchMany(createBaseOpts(), cancellationTokenSource.token);

			// Should fail: the connectivity checks used the dead default fetcher
			expect(result.type).toBe(ChatFetchResponseType.NetworkError);
			// Verify that connectivity checks did NOT use node-fetch
			const fetcherIds = mockFetcherService.fetcherIdsUsed;
			expect(fetcherIds[1]).toBeUndefined(); // default fetcher, not node-fetch
		});

		it('does NOT fall back to node-fetch for non-crash network errors', async () => {
			configurationService.setConfig(ConfigKey.TeamInternal.RetryNetworkErrors, true);
			configurationService.setConfig(ConfigKey.TeamInternal.FallbackNodeFetchOnNetworkProcessCrash, true);

			// Regular network error (not a crash) — should NOT trigger node-fetch fallback
			mockFetcherService.queueError(createNetworkError('ENOTFOUND'));
			mockFetcherService.queueResponse(createSuccessResponse('{}')); // connectivity check
			mockFetcherService.queueResponse(createSuccessResponse('Success!')); // retry

			const result = await fetcher.fetchMany(createBaseOpts(), cancellationTokenSource.token);

			expect(result.type).toBe(ChatFetchResponseType.Success);
			// Verify that connectivity check used the default fetcher, not node-fetch
			const fetcherIds = mockFetcherService.fetcherIdsUsed;
			expect(fetcherIds[1]).toBeUndefined(); // default fetcher
		});

		it('does NOT fall back when RetryNetworkErrors is disabled even if crash flag is enabled', async () => {
			configurationService.setConfig(ConfigKey.TeamInternal.RetryNetworkErrors, false);
			configurationService.setConfig(ConfigKey.TeamInternal.FallbackNodeFetchOnNetworkProcessCrash, true);

			mockFetcherService.queueError(createNetworkProcessCrashedError());

			const result = await fetcher.fetchMany(createBaseOpts(), cancellationTokenSource.token);

			// Should fail without retry: the general retry-on-network-error flag is off
			expect(result.type).toBe(ChatFetchResponseType.NetworkError);
			expect(mockFetcherService.fetchCallCount).toBe(1);
		});

		it('sets isNetworkProcessCrash flag on the error result', async () => {
			configurationService.setConfig(ConfigKey.TeamInternal.RetryNetworkErrors, false);
			configurationService.setConfig(ConfigKey.TeamInternal.FallbackNodeFetchOnNetworkProcessCrash, false);

			mockFetcherService.queueError(createNetworkProcessCrashedError());

			const result = await fetcher.fetchMany(createBaseOpts(), cancellationTokenSource.token);

			expect(result.type).toBe(ChatFetchResponseType.NetworkError);
			if (result.type === ChatFetchResponseType.NetworkError) {
				expect(result.isNetworkProcessCrash).toBe(true);
			}
		});

		it('does not set isNetworkProcessCrash flag for regular network errors', async () => {
			configurationService.setConfig(ConfigKey.TeamInternal.RetryNetworkErrors, false);

			mockFetcherService.queueError(createNetworkError('ENOTFOUND'));

			const result = await fetcher.fetchMany(createBaseOpts(), cancellationTokenSource.token);

			expect(result.type).toBe(ChatFetchResponseType.NetworkError);
			if (result.type === ChatFetchResponseType.NetworkError) {
				expect(result.isNetworkProcessCrash).toBeUndefined();
			}
		});
	});

	describe('MalformedFormat retry logic', () => {
		it('retries up to MAX_MALFORMED_RETRIES=2 times for MalformedFormat errors', async () => {
			// Use a custom endpoint that returns MalformedFormat on first 2 attempts, then success
			const malformedEndpoint = createMalformedEndpoint([
				{ finishReason: 'content_filter', filterReason: 'malformed_format', text: 'I will help you.' },
				{ finishReason: 'content_filter', filterReason: 'malformed_format', text: 'Sure thing!' },
				{ finishReason: 'stop', text: '<thinking>ok</thinking>' },
			]);

			// Queue 3 fetch responses (initial + 2 retries)
			mockFetcherService.queueResponse(createSuccessResponse('malformed1'));
			mockFetcherService.queueResponse(createSuccessResponse('malformed2'));
			mockFetcherService.queueResponse(createSuccessResponse('success'));

			const opts = createBaseOpts();
			opts.endpoint = malformedEndpoint;
			opts.enableRetryOnFilter = true;

			const result = await fetcher.fetchMany(opts, cancellationTokenSource.token);

			expect(result.type).toBe(ChatFetchResponseType.Success);
			// 3 fetch calls: initial + 2 retries
			expect(mockFetcherService.fetchCallCount).toBe(3);
		});

		it('gives up after MAX_MALFORMED_RETRIES=2 if all attempts return MalformedFormat', async () => {
			const malformedEndpoint = createMalformedEndpoint([
				{ finishReason: 'content_filter', filterReason: 'malformed_format', text: 'I will help.' },
				{ finishReason: 'content_filter', filterReason: 'malformed_format', text: 'Sure thing!' },
				{ finishReason: 'content_filter', filterReason: 'malformed_format', text: 'Let me do that.' },
			]);

			mockFetcherService.queueResponse(createSuccessResponse('malformed1'));
			mockFetcherService.queueResponse(createSuccessResponse('malformed2'));
			mockFetcherService.queueResponse(createSuccessResponse('malformed3'));

			const opts = createBaseOpts();
			opts.endpoint = malformedEndpoint;
			opts.enableRetryOnFilter = true;

			const result = await fetcher.fetchMany(opts, cancellationTokenSource.token);

			expect(result.type).toBe(ChatFetchResponseType.Filtered);
			if (result.type === ChatFetchResponseType.Filtered) {
				expect(result.reason).toContain('malformed response');
			}
		});

		it('does not retry MalformedFormat when _malformedRetryCount already at max', async () => {
			const malformedEndpoint = createMalformedEndpoint([
				{ finishReason: 'content_filter', filterReason: 'malformed_format', text: 'Bad response' },
			]);

			mockFetcherService.queueResponse(createSuccessResponse('malformed'));

			const opts = createBaseOpts();
			opts.endpoint = malformedEndpoint;
			opts.enableRetryOnFilter = true;
			opts._malformedRetryCount = 2; // Already at max

			const result = await fetcher.fetchMany(opts, cancellationTokenSource.token);

			expect(result.type).toBe(ChatFetchResponseType.Filtered);
			// Should NOT retry — only 1 fetch call
			expect(mockFetcherService.fetchCallCount).toBe(1);
		});

		it('includes escalating correction messages in retry', async () => {
			const capturedMessages: Raw.ChatMessage[][] = [];
			const malformedEndpoint = createMalformedEndpoint([
				{ finishReason: 'content_filter', filterReason: 'malformed_format', text: 'No XML here' },
				{ finishReason: 'content_filter', filterReason: 'malformed_format', text: 'Still no XML' },
				{ finishReason: 'content_filter', filterReason: 'malformed_format', text: 'Third failure' },
			], capturedMessages);

			mockFetcherService.queueResponse(createSuccessResponse('m1'));
			mockFetcherService.queueResponse(createSuccessResponse('m2'));
			mockFetcherService.queueResponse(createSuccessResponse('m3'));

			const opts = createBaseOpts();
			opts.endpoint = malformedEndpoint;
			opts.enableRetryOnFilter = true;

			await fetcher.fetchMany(opts, cancellationTokenSource.token);

			// First retry should include standard correction (not "CRITICAL ERROR")
			// Second retry should include escalating message with "CRITICAL ERROR"
			expect(capturedMessages.length).toBeGreaterThanOrEqual(2);

			// Check second retry messages (index 1) contain the correction
			if (capturedMessages.length >= 2) {
				const firstRetryMsgs = capturedMessages[1];
				const lastMsg = firstRetryMsgs[firstRetryMsgs.length - 1];
				const text = lastMsg.content?.[0] && 'text' in lastMsg.content[0] ? lastMsg.content[0].text : '';
				expect(text).toContain('REJECTED');
			}

			// Check third retry messages (index 2) contain the escalating correction
			if (capturedMessages.length >= 3) {
				const secondRetryMsgs = capturedMessages[2];
				const lastMsg = secondRetryMsgs[secondRetryMsgs.length - 1];
				const text = lastMsg.content?.[0] && 'text' in lastMsg.content[0] ? lastMsg.content[0].text : '';
				expect(text).toContain('CRITICAL ERROR');
				expect(text).toContain('SECOND failed attempt');
			}
		});
	});
});

// --- Test Helpers ---

/**
 * Mock fetcher service that queues responses for testing retry logic.
 */
class MockFetcherService {
	private _responseQueue: (Response | Error)[] = [];
	private _fetchCallCount = 0;

	get fetchCallCount(): number {
		return this._fetchCallCount;
	}

	queueResponse(response: Response): void {
		this._responseQueue.push(response);
	}

	queueError(error: Error): void {
		this._responseQueue.push(error);
	}

	/**
	 * The `useFetcher` values passed to each `fetch` call, in order.
	 * Used to verify that the retry logic correctly switches fetchers.
	 */
	private _fetcherIdsUsed: (string | undefined)[] = [];

	get fetcherIdsUsed(): (string | undefined)[] {
		return this._fetcherIdsUsed;
	}

	async fetch(_url: string, options?: any): Promise<Response> {
		this._fetchCallCount++;
		this._fetcherIdsUsed.push(options?.useFetcher);
		const next = this._responseQueue.shift();
		if (!next) {
			throw new Error('No more queued responses');
		}
		if (next instanceof Error) {
			throw next;
		}
		return next;
	}

	fetchWithPagination<T>(): Promise<T[]> {
		throw new Error('Method not implemented.');
	}

	disconnectAll(): Promise<void> {
		return Promise.resolve();
	}

	makeAbortController(): AbortController {
		return new AbortController();
	}

	isAbortError(_err: unknown): boolean {
		return false;
	}

	isInternetDisconnectedError(_err: unknown): boolean {
		return false;
	}

	isFetcherError(err: unknown): boolean {
		return err instanceof Error && 'code' in err;
	}

	isNetworkProcessCrashedError(err: unknown): boolean {
		return !!(err && typeof err === 'object' && 'chromiumDetails' in err &&
			(err as { chromiumDetails?: ElectronFetchErrorChromiumDetails }).chromiumDetails?.network_process_crashed === true);
	}

	getUserMessageForFetcherError(_err: unknown): string {
		return 'Network error occurred';
	}

	getUserAgentLibrary(): string {
		return 'test-agent';
	}
}

/**
 * Extended mock authentication service that returns a valid token.
 */
class TestAuthenticationService extends MockAuthenticationService {
	override getCopilotToken(_force?: boolean): Promise<CopilotToken> {
		return Promise.resolve({
			token: 'test-token',
			username: 'test-user',
		} as CopilotToken);
	}
}

/**
 * Extended mock CAPI client service that provides the ping URL.
 */
class TestCAPIClientService extends MockCAPIClientService {
	get capiPingURL(): string {
		return 'https://api.github.com/copilot_internal/ping';
	}
}

function createMockInteractionService(): IInteractionService {
	return {
		_serviceBrand: undefined,
		onInteractionStateChanged: Event.None,
		sendChatInteraction: () => { },
		getInteractionState: () => undefined,
	} as unknown as IInteractionService;
}

function createMockEndpoint(): IChatEndpoint {
	return {
		url: 'https://api.github.com/copilot/chat/completions',
		urlOrRequestMetadata: 'https://api.github.com/copilot/chat/completions',
		model: 'test-model',
		modelMaxPromptTokens: 8192,
		maxOutputTokens: 4096,
		supportsToolCalls: true,
		supportsVision: false,
		supportsPrediction: false,
		showInModelPicker: true,
		isDefault: true,
		isFallback: false,
		policy: 'enabled',
		getHeaders: async () => ({}),
		createRequestBody: () => ({
			model: 'test-model',
			messages: [],
			stream: true
		}),
		acquireTokenizer: () => ({
			countMessagesTokens: async () => 100,
			countTokens: async () => 100,
			tokenize: async () => [],
		}),
		processResponseFromChatEndpoint: async (_telemetryService: ITelemetryService, _logService: ILogService, response: Response, _expectedNumChoices: number, finishedCb: FinishedCallback, telemetryData: TelemetryData, _cancellationToken?: CancellationToken) => {
			// Stream the response text through the callback
			const text = await response.text();
			if (finishedCb) {
				await finishedCb(text, 0, { text });
			}
			// Return an async iterable of ChatCompletion objects
			return {
				[Symbol.asyncIterator]: async function* () {
					yield {
						message: { role: Raw.ChatRole.Assistant, content: [{ type: Raw.ChatCompletionContentPartKind.Text, text }] },
						choiceIndex: 0,
						requestId: {
							headerRequestId: response.headers.get('x-request-id') || 'test-request-id',
							gitHubRequestId: response.headers.get('x-github-request-id') || '',
							completionId: '',
							created: 0,
							serverExperiments: '',
							deploymentId: '',
						},
						tokens: [],
						usage: undefined,
						model: 'test-model',
						blockFinished: true,
						finishReason: 'stop',
						telemetryData: telemetryData,
					};
				}
			};
		},
		acceptChatPolicy: async () => true,
		doRequest: async () => {
			throw new Error('Not implemented');
		},
	} as unknown as IChatEndpoint;
}

function createMockChatQuotaService(): IChatQuotaService {
	return {
		_serviceBrand: undefined,
		processQuotaHeaders: () => { },
	} as unknown as IChatQuotaService;
}

function createMockConversationOptions() {
	return {
		_serviceBrand: undefined,
		maxResponseTokens: 4096,
		temperature: 0.5,
		topP: 1,
		rejectionMessage: 'rejected',
	};
}

function createMockPowerService(): IPowerService {
	return {
		_serviceBrand: undefined,
		acquirePowerSaveBlocker: () => ({ dispose: () => { } }),
	};
}

/**
 * Simple FakeHeaders implementation that accepts initial headers.
 */
class FakeHeaders implements IHeaders {
	constructor(private readonly headers = new Map<string, string>()) { }
	get(name: string): string | null {
		return this.headers.get(name.toLowerCase()) ?? null;
	}
	*[Symbol.iterator](): Iterator<[string, string]> {
		yield* this.headers.entries();
	}
}

function createSuccessResponse(content: string): Response {
	const streamContent = `data: {"choices":[{"delta":{"content":"${content}"},"index":0}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\ndata: [DONE]\n\n`;
	return Response.fromText(
		200,
		'OK',
		new FakeHeaders(new Map([
			['content-type', 'text/event-stream'],
		])),
		streamContent,
		'node-fetch'
	);
}

function createErrorResponse(status: number, statusText: string): Response {
	return Response.fromText(
		status,
		statusText,
		new FakeHeaders(),
		JSON.stringify({ error: { message: statusText } }),
		'node-fetch'
	);
}

function createNetworkError(code: string): Error & { code: string } {
	const error = new Error(`Network error: ${code}`) as Error & { code: string };
	error.code = code;
	return error;
}

/**
 * Creates an error that simulates Electron's network process crashing.
 * Electron attaches `chromiumDetails` with structured error info to the error object.
 */
function createNetworkProcessCrashedError(): Error & { code: string; chromiumDetails: ElectronFetchErrorChromiumDetails } {
	const error = new Error('net::ERR_FAILED') as any;
	error.code = 'ERR_FAILED';
	error.chromiumDetails = { is_request_error: true, network_process_crashed: true } satisfies ElectronFetchErrorChromiumDetails;
	return error;
}

/**
 * Describes a single response that createMalformedEndpoint will return.
 */
interface MalformedEndpointResponse {
	finishReason: string;
	filterReason?: string;
	text: string;
}

/**
 * Creates a mock endpoint that returns sequential responses with configurable
 * finish reasons and filter reasons. This allows testing the MalformedFormat
 * retry logic end-to-end through chatMLFetcher.
 *
 * @param responses - Ordered list of responses to return on each call
 * @param capturedMessages - If provided, captures the messages array for each call
 */
function createMalformedEndpoint(
	responses: MalformedEndpointResponse[],
	capturedMessages?: Raw.ChatMessage[][],
): IChatEndpoint {
	let callIndex = 0;
	const base = createMockEndpoint();

	return {
		...base,
		processResponseFromChatEndpoint: async (
			_telemetryService: ITelemetryService,
			_logService: ILogService,
			_response: Response,
			_expectedNumChoices: number,
			finishedCb: FinishedCallback,
			telemetryData: TelemetryData,
			_cancellationToken?: CancellationToken,
		) => {
			const current = responses[callIndex] ?? responses[responses.length - 1];
			callIndex++;

			const text = current.text;
			if (finishedCb) {
				await finishedCb(text, 0, { text });
			}

			return {
				[Symbol.asyncIterator]: async function* () {
					yield {
						message: {
							role: Raw.ChatRole.Assistant,
							content: [{ type: Raw.ChatCompletionContentPartKind.Text, text }],
						},
						choiceIndex: 0,
						requestId: {
							headerRequestId: 'test-request-id',
							gitHubRequestId: '',
							completionId: '',
							created: 0,
							serverExperiments: '',
							deploymentId: '',
						},
						tokens: [],
						usage: undefined,
						model: 'test-model',
						blockFinished: true,
						finishReason: current.finishReason as FinishedCompletionReason,
						filterReason: current.filterReason as FilterReason | undefined,
						telemetryData: telemetryData,
					};
				},
			};
		},
		// Override createRequestBody to capture messages for assertion
		createRequestBody: (options: any) => {
			if (capturedMessages) {
				capturedMessages.push([...options.messages]);
			}
			return base.createRequestBody(options);
		},
	} as unknown as IChatEndpoint;
}
