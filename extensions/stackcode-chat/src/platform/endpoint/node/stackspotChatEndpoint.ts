/*---------------------------------------------------------------------------------------------
 *  StackCode - Stackspot AI Chat Endpoint
 *
 *  Extends ChatEndpoint to route all chat requests to Stackspot AI instead of
 *  GitHub Copilot / OpenAI. Overrides:
 *  - urlOrRequestMetadata → Stackspot agent chat URL (string, not RequestMetadata)
 *  - createRequestBody() → converts messages[] to { streaming, user_prompt, ... }
 *  - processResponseFromChatEndpoint() → parses Stackspot SSE into ChatCompletion
 *  - getExtraHeaders() → injects correct Authorization with real Stackspot OAuth2 token
 *  - interceptBody() → no-op (prevent upstream from stripping fields)
 *  - cloneWithTokenOverride() → creates StackspotChatEndpoint (not vanilla ChatEndpoint)
 *--------------------------------------------------------------------------------------------*/

import { Raw } from '@vscode/prompt-tsx';
import type { CancellationToken } from 'vscode';
import { AsyncIterableObject } from '../../../util/vs/base/common/async';
import { deepClone, mixin } from '../../../util/vs/base/common/objects';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IChatMLFetcher } from '../../chat/common/chatMLFetcher';
import { ChatLocation } from '../../chat/common/commonTypes';
import { getTextPart, toTextParts } from '../../chat/common/globalStringUtils';
import { IConfigurationService } from '../../configuration/common/configurationService';
import { ILogService } from '../../log/common/logService';
import { FinishedCallback } from '../../networking/common/fetch';
import { Response } from '../../networking/common/fetcherService';
import { IChatEndpoint, ICreateEndpointBodyOptions, IEndpointBody } from '../../networking/common/networking';
import { ChatCompletion, FinishedCompletionReason } from '../../networking/common/openai';
import { IExperimentationService } from '../../telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../telemetry/common/telemetry';
import { TelemetryData } from '../../telemetry/common/telemetryData';
import { ITokenizerProvider } from '../../tokenizer/node/tokenizer';
import { IDomainService } from '../common/domainService';
import { IChatModelInformation } from '../common/endpointProvider';
import { ChatEndpoint } from './chatEndpoint';
import { StackspotAuthService } from '../../stackspot/auth';
import { StackspotSSEResponse } from '../../stackspot/types';

/**
 * Chat endpoint that routes all requests to Stackspot AI.
 *
 * Key differences from CopilotChatEndpoint:
 * - urlOrRequestMetadata is a string URL (triggers fetcher.fetch() path, not CAPI client)
 * - createRequestBody() produces Stackspot format: { streaming, user_prompt, ... }
 * - processResponseFromChatEndpoint() parses Stackspot SSE (data: {"message": "...", ...})
 * - getExtraHeaders() overrides Authorization with real Stackspot OAuth2 Bearer token
 */
export class StackspotChatEndpoint extends ChatEndpoint {
	constructor(
		modelMetadata: IChatModelInformation,
		private readonly _stackspotAuth: StackspotAuthService,
		private readonly _agentId: string,
		@IDomainService domainService: IDomainService,
		@IChatMLFetcher chatMLFetcher: IChatMLFetcher,
		@ITokenizerProvider tokenizerProvider: ITokenizerProvider,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService experimentService: IExperimentationService,
		@ILogService private readonly _stackspotLogService: ILogService,
	) {
		super(
			modelMetadata,
			domainService,
			chatMLFetcher,
			tokenizerProvider,
			instantiationService,
			configurationService,
			experimentService,
			_stackspotLogService,
		);
	}

	/**
	 * Returns a string URL for the Stackspot agent chat endpoint.
	 * Using a string (not RequestMetadata) triggers the fetcher.fetch() path
	 * in networkRequest(), bypassing CAPI client resolution entirely.
	 */
	public override get urlOrRequestMetadata(): string {
		return `https://genai-inference-app.stackspot.com/v1/agent/${this._agentId}/chat`;
	}

	/**
	 * Injects the correct Authorization header with the real Stackspot OAuth2 token.
	 *
	 * The default flow sets `Authorization: Bearer ${copilotToken.token}` where
	 * copilotToken.token is our synthetic string. We override that by returning
	 * the correct header here — getExtraHeaders() is spread AFTER the default
	 * Authorization header in networkRequest() (networking.ts line 334-342),
	 * so it overwrites the synthetic token with the real one.
	 */
	public override getExtraHeaders(_location?: ChatLocation): Record<string, string> {
		// Access the cached token from modelMetadata where StackspotEndpointProvider stores it.
		// At this point in the flow, getCopilotToken() was already called successfully
		// (which calls getAccessToken()), so the token is guaranteed to be cached.
		const accessToken: string | undefined = (this.modelMetadata as any)._stackspotAccessToken;

		if (!accessToken) {
			this._stackspotLogService.warn('[stackcode] No cached access token available for headers');
			return {};
		}

		// Note: Content-Type is NOT set here because the fetcher layer already sets it
		// when `json: body` is used in the request options (baseFetchFetcher.ts line 36-37).
		return {
			'Authorization': `Bearer ${accessToken}`,
		};
	}

	/**
	 * Creates the Stackspot request body format.
	 *
	 * Stackspot API expects:
	 * {
	 *   "streaming": true,
	 *   "user_prompt": "full conversation as string",
	 *   "stackspot_knowledge": false
	 * }
	 *
	 * NOT the OpenAI messages[] format.
	 */
	public override createRequestBody(options: ICreateEndpointBodyOptions): IEndpointBody {
		const userPrompt = this._convertMessagesToUserPrompt(options.messages);

		// Return as IEndpointBody — the Stackspot-specific fields will be serialized by
		// the JSON body in networkRequest(). The IEndpointBody type is loose enough
		// (has optional fields) that this works.
		const body: Record<string, unknown> = {
			streaming: true,
			user_prompt: userPrompt,
			use_conversation: false,
			stackspot_knowledge: false,
		};

		return body as unknown as IEndpointBody;
	}

	/**
	 * No-op interceptBody to prevent upstream from removing fields
	 * (e.g. removing 'tools' because supportsToolCalls is false,
	 *  or changing 'stream' because _supportsStreaming might be false).
	 * The Stackspot body format doesn't have these fields, so the base class
	 * wouldn't break anything, but no-op is safer and cleaner.
	 */
	public override interceptBody(_body: IEndpointBody | undefined): void {
		// No-op — Stackspot body is already in final form
	}

	/**
	 * Processes the Stackspot SSE response and converts to ChatCompletion objects.
	 *
	 * Stackspot SSE format:
	 *   data: {"message": "token text", ...}
	 *   data: {"stop_reason": "stop", "tokens": {...}, "conversation_id": "...", ...}
	 *
	 * We bypass SSEProcessor entirely and directly parse Stackspot format.
	 */
	public override async processResponseFromChatEndpoint(
		_telemetryService: ITelemetryService,
		logService: ILogService,
		response: Response,
		_expectedNumChoices: number,
		finishCallback: FinishedCallback,
		telemetryData: TelemetryData,
		cancellationToken?: CancellationToken | undefined,
	): Promise<AsyncIterableObject<ChatCompletion>> {
		const self = this;

		return new AsyncIterableObject<ChatCompletion>(async (emitter) => {
			const textDecoder = response.body.pipeThrough(new TextDecoderStream());
			let extraData = '';
			const allTokens: string[] = [];
			let inputTokens = 0;
			let outputTokens = 0;
			const requestId = {
				headerRequestId: response.headers.get('X-Request-ID') ?? generateUuid(),
				gitHubRequestId: '',
				completionId: generateUuid(),
				created: Math.floor(Date.now() / 1000),
				deploymentId: '',
				serverExperiments: '',
			};
			let emittedCompletion = false;
			let truncated = false;

			try {
				for await (const chunk of textDecoder) {
					if (cancellationToken?.isCancellationRequested || truncated) {
						break;
					}

					const combined = extraData + chunk;
					const lines = combined.split('\n');
					extraData = lines.pop() ?? '';

					for (const line of lines) {
						if (truncated) {
							break;
						}

						const trimmed = line.trim();
						if (!trimmed || trimmed.startsWith(':')) {
							continue;
						}

						if (!trimmed.startsWith('data:')) {
							continue;
						}

						const dataStr = trimmed.slice(5).trim();
						if (dataStr === '[DONE]') {
							continue;
						}

						let parsed: StackspotSSEResponse;
						try {
							parsed = JSON.parse(dataStr);
						} catch (e) {
							logService.error(`[stackcode] Error parsing SSE chunk: ${dataStr}`);
							continue;
						}

						// Final chunk with stop_reason
						if (parsed.stop_reason) {
							inputTokens = parsed.tokens?.input ?? 0;
							outputTokens = parsed.tokens?.output ?? 0;

							const fullText = allTokens.join('');
							await finishCallback(fullText, 0, {
								text: '',
							});

							self._emitCompletion(emitter, fullText, allTokens, inputTokens, outputTokens, requestId, FinishedCompletionReason.Stop, telemetryData);
							emittedCompletion = true;
							continue;
						}

						// Regular message chunk
						if (parsed.message !== undefined && parsed.message !== null) {
							const token = parsed.message;
							if (token.length > 0) {
								allTokens.push(token);

								// Call finishCallback with accumulated text + new delta.
								// Respect truncation signal: if finishCallback returns a number,
								// the caller wants us to stop reading.
								const fullText = allTokens.join('');
								const truncateAt = await finishCallback(fullText, 0, {
									text: token,
								});
								if (truncateAt !== undefined) {
									truncated = true;
									break;
								}
							}
						}
					}
				}

				// Handle remaining data in buffer
				if (!truncated && extraData.trim()) {
					const trimmed = extraData.trim();
					if (trimmed.startsWith('data:')) {
						const dataStr = trimmed.slice(5).trim();
						if (dataStr !== '[DONE]') {
							try {
								const parsed: StackspotSSEResponse = JSON.parse(dataStr);
								if (parsed.stop_reason) {
									inputTokens = parsed.tokens?.input ?? 0;
									outputTokens = parsed.tokens?.output ?? 0;

									if (!emittedCompletion) {
										const fullText = allTokens.join('');
										await finishCallback(fullText, 0, { text: '' });
										self._emitCompletion(emitter, fullText, allTokens, inputTokens, outputTokens, requestId, FinishedCompletionReason.Stop, telemetryData);
										emittedCompletion = true;
									}
								} else if (parsed.message) {
									allTokens.push(parsed.message);
									const fullText = allTokens.join('');
									await finishCallback(fullText, 0, { text: parsed.message });
								}
							} catch {
								logService.error(`[stackcode] Error parsing final SSE buffer: ${dataStr}`);
							}
						}
					}
				}

				// Fallback: if we accumulated tokens but never emitted a completion
				// (stop_reason was never received — e.g. server error, truncation),
				// emit whatever we have so the caller gets a response.
				if (!emittedCompletion && allTokens.length > 0) {
					const fullText = allTokens.join('');
					const reason = truncated ? FinishedCompletionReason.Length : FinishedCompletionReason.Stop;
					self._emitCompletion(emitter, fullText, allTokens, inputTokens, outputTokens, requestId, reason, telemetryData);
					emittedCompletion = true;
				}

			} catch (err) {
				logService.error(`[stackcode] Error processing Stackspot SSE stream: ${err}`);
				// Emit error completion with whatever text we accumulated
				const fullText = allTokens.join('') || 'Error processing response from StackSpot AI';
				self._emitCompletion(emitter, fullText, allTokens, inputTokens, outputTokens, requestId, FinishedCompletionReason.ServerError, telemetryData);
			} finally {
				try {
					await response.body.destroy();
				} catch {
					// ignore cleanup errors
				}
			}
		});
	}

	/**
	 * Emits a ChatCompletion to the AsyncIterableObject emitter.
	 * Extracted to avoid duplication across stop_reason, fallback, and error paths.
	 */
	private _emitCompletion(
		emitter: { emitOne: (value: ChatCompletion) => void },
		fullText: string,
		allTokens: string[],
		inputTokens: number,
		outputTokens: number,
		requestId: ChatCompletion['requestId'],
		finishReason: FinishedCompletionReason,
		telemetryData: TelemetryData,
	): void {
		const message: Raw.ChatMessage = {
			role: Raw.ChatRole.Assistant,
			content: toTextParts(fullText),
		};

		emitter.emitOne({
			message,
			choiceIndex: 0,
			requestId,
			tokens: allTokens,
			usage: inputTokens || outputTokens ? {
				prompt_tokens: inputTokens,
				completion_tokens: outputTokens,
				total_tokens: inputTokens + outputTokens,
			} : undefined,
			model: this.model,
			blockFinished: false,
			finishReason,
			telemetryData,
		});
	}

	/**
	 * Override cloneWithTokenOverride to create a StackspotChatEndpoint (not vanilla ChatEndpoint).
	 * This preserves all Stackspot overrides when the endpoint is cloned.
	 */
	public override cloneWithTokenOverride(modelMaxPromptTokens: number): IChatEndpoint {
		const clonedMetadata = mixin(
			deepClone(this.modelMetadata),
			{ capabilities: { limits: { max_prompt_tokens: modelMaxPromptTokens } } },
		);
		// Preserve the cached access token on the cloned metadata
		(clonedMetadata as any)._stackspotAccessToken = (this.modelMetadata as any)._stackspotAccessToken;

		return this._instantiationService.createInstance(
			StackspotChatEndpoint,
			clonedMetadata,
			this._stackspotAuth,
			this._agentId,
		);
	}

	/**
	 * Converts Raw.ChatMessage[] to a single user_prompt string for Stackspot.
	 * Stackspot does NOT support messages array — everything goes in user_prompt.
	 */
	private _convertMessagesToUserPrompt(messages: Raw.ChatMessage[]): string {
		const parts: string[] = [];

		for (const message of messages) {
			const text = getTextPart(message.content);
			if (!text.trim()) {
				continue;
			}

			switch (message.role) {
				case Raw.ChatRole.System:
					parts.push(`[System]\n${text}`);
					break;
				case Raw.ChatRole.User:
					parts.push(`[User]\n${text}`);
					break;
				case Raw.ChatRole.Assistant:
					parts.push(`[Assistant]\n${text}`);
					break;
				case Raw.ChatRole.Tool:
					parts.push(`[Tool Result]\n${text}`);
					break;
				default:
					parts.push(text);
					break;
			}
		}

		return parts.join('\n\n');
	}
}
