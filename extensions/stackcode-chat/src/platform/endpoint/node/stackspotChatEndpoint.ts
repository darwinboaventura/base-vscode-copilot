/*---------------------------------------------------------------------------------------------
 *  StackCode - Stackspot AI Chat Endpoint
 *
 *  Extends ChatEndpoint to route all chat requests to Stackspot AI instead of
 *  GitHub Copilot / OpenAI. Overrides:
 *  - urlOrRequestMetadata → Stackspot agent chat URL (string, not RequestMetadata)
 *  - createRequestBody() → converts messages[] to { streaming, user_prompt, ... }
 *    with tool definitions injected when tools are available (Agent mode)
 *  - processResponseFromChatEndpoint() → parses Stackspot SSE, detects XML tool
 *    calls in the response text, and emits proper FinishedCallback deltas
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
import { FinishedCallback, OpenAiFunctionTool } from '../../networking/common/fetch';
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
import {
	StreamingToolCallParser,
	ToolCallParserEventKind,
	formatToolDefinitionsForPrompt,
	getToolCallingSystemPrompt,
	FORMAT_REMINDER_INSTRUCTION,
} from '../../stackspot/toolCallParser';

/**
 * Chat endpoint that routes all requests to Stackspot AI.
 *
 * Key differences from CopilotChatEndpoint:
 * - urlOrRequestMetadata is a string URL (triggers fetcher.fetch() path, not CAPI client)
 * - createRequestBody() produces Stackspot format: { streaming, user_prompt, ... }
 *   with tool definitions injected in the prompt when tools are provided
 * - processResponseFromChatEndpoint() parses Stackspot SSE (data: {"message": "...", ...})
 *   and detects structured tool calls in XML format within the response text
 * - getExtraHeaders() overrides Authorization with real Stackspot OAuth2 Bearer token
 */
export class StackspotChatEndpoint extends ChatEndpoint {

	/**
	 * Stores the tools from the last createRequestBody() call so that
	 * processResponseFromChatEndpoint() knows whether to parse for tool calls.
	 */
	private _lastRequestTools: OpenAiFunctionTool[] | undefined;

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
		const accessToken: string | undefined = (this.modelMetadata as any)._stackspotAccessToken;

		if (!accessToken) {
			this._stackspotLogService.warn('[stackcode] No cached access token available for headers');
			return {};
		}

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
	 *   "use_conversation": false,
	 *   "stackspot_knowledge": false
	 * }
	 *
	 * When tools are provided (Agent mode), the tool definitions and calling
	 * instructions are injected into the user_prompt as a structured prefix.
	 * This teaches the LLM to respond with XML-formatted tool calls.
	 */
	public override createRequestBody(options: ICreateEndpointBodyOptions): IEndpointBody {
		// Extract tools from postOptions (populated by chatMLFetcher from requestOptions).
		// Both options.postOptions.tools and options.requestOptions.tools carry the same tools;
		// we use postOptions as the primary carrier (see createCapiRequestBody in networking.ts).
		const tools = options.postOptions?.tools ?? options.requestOptions?.tools as OpenAiFunctionTool[] | undefined;
		this._lastRequestTools = tools;

		const userPrompt = this._convertMessagesToUserPrompt(options.messages, tools);

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
	 * When tools are available (Agent mode), the response text is fed through
	 * a StreamingToolCallParser that detects XML tool call blocks. Detected
	 * tool calls are emitted via FinishedCallback deltas in the exact format
	 * that toolCallingLoop expects:
	 *   - beginToolCalls: when a tool call name is parsed
	 *   - copilotToolCallStreamUpdates: as arguments are being streamed
	 *   - copilotToolCalls: when a tool call is complete
	 *
	 * When no tools are available, it behaves as a simple text passthrough.
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
		const hasTools = !!this._lastRequestTools && this._lastRequestTools.length > 0;

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

			// Tool call parser — only active when tools are provided
			const parser = hasTools ? new StreamingToolCallParser() : undefined;
			const completedToolCalls: Array<{ name: string; arguments: string; id: string }> = [];
			const plainTextParts: string[] = [];
			let thinkingText = '';

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

							if (parser) {
								// Flush the parser to get any remaining events
								const flushEvents = parser.flush();
								for (const event of flushEvents) {
									await self._handleParserEvent(event, finishCallback, allTokens, completedToolCalls, plainTextParts, (t) => { thinkingText += t; });
								}

								// Determine finish reason based on whether tool calls were detected
								const hasDetectedToolCalls = completedToolCalls.length > 0;
								const finishReason = hasDetectedToolCalls
									? FinishedCompletionReason.ToolCalls
									: FinishedCompletionReason.Stop;

								if (hasDetectedToolCalls) {
									// Emit final delta with all completed tool calls
									const fullText = plainTextParts.join('');
									await finishCallback(fullText, 0, {
										text: '',
										copilotToolCalls: completedToolCalls.map(tc => ({
											name: tc.name,
											arguments: tc.arguments,
											id: tc.id,
										})),
									});
									self._emitCompletion(emitter, fullText, allTokens, inputTokens, outputTokens, requestId, finishReason, telemetryData);
								} else {
									// No tool calls — emit as plain text
									const fullText = plainTextParts.join('');
									await finishCallback(fullText, 0, { text: '' });
									self._emitCompletion(emitter, fullText, allTokens, inputTokens, outputTokens, requestId, finishReason, telemetryData);
								}
							} else {
								// No tools mode — simple text passthrough
								const fullText = allTokens.join('');
								await finishCallback(fullText, 0, { text: '' });
								self._emitCompletion(emitter, fullText, allTokens, inputTokens, outputTokens, requestId, FinishedCompletionReason.Stop, telemetryData);
							}
							emittedCompletion = true;
							continue;
						}

						// Regular message chunk
						if (parsed.message !== undefined && parsed.message !== null) {
							const token = parsed.message;
							if (token.length > 0) {
								allTokens.push(token);

								if (parser) {
									// Feed through the tool call parser
									const events = parser.feed(token);
									for (const event of events) {
										const shouldTruncate = await self._handleParserEvent(
											event, finishCallback, allTokens, completedToolCalls, plainTextParts,
											(t) => { thinkingText += t; },
										);
										if (shouldTruncate) {
											truncated = true;
											break;
										}
									}
								} else {
									// No tools — direct passthrough
									const fullText = allTokens.join('');
									const truncateAt = await finishCallback(fullText, 0, { text: token });
									if (truncateAt !== undefined) {
										truncated = true;
										break;
									}
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
										if (parser) {
											const flushEvents = parser.flush();
											for (const event of flushEvents) {
												await self._handleParserEvent(event, finishCallback, allTokens, completedToolCalls, plainTextParts, (t) => { thinkingText += t; });
											}

											const hasDetectedToolCalls = completedToolCalls.length > 0;
											const finishReason = hasDetectedToolCalls
												? FinishedCompletionReason.ToolCalls
												: FinishedCompletionReason.Stop;

											const fullText = plainTextParts.join('');
											if (hasDetectedToolCalls) {
												await finishCallback(fullText, 0, {
													text: '',
													copilotToolCalls: completedToolCalls,
												});
											} else {
												await finishCallback(fullText, 0, { text: '' });
											}
											self._emitCompletion(emitter, fullText, allTokens, inputTokens, outputTokens, requestId, finishReason, telemetryData);
										} else {
											const fullText = allTokens.join('');
											await finishCallback(fullText, 0, { text: '' });
											self._emitCompletion(emitter, fullText, allTokens, inputTokens, outputTokens, requestId, FinishedCompletionReason.Stop, telemetryData);
										}
										emittedCompletion = true;
									}
								} else if (parsed.message) {
									allTokens.push(parsed.message);
									if (parser) {
										const events = parser.feed(parsed.message);
										for (const event of events) {
											await self._handleParserEvent(event, finishCallback, allTokens, completedToolCalls, plainTextParts, (t) => { thinkingText += t; });
										}
									} else {
										const fullText = allTokens.join('');
										await finishCallback(fullText, 0, { text: parsed.message });
									}
								}
							} catch {
								logService.error(`[stackcode] Error parsing final SSE buffer: ${dataStr}`);
							}
						}
					}
				}

				// Fallback: if we accumulated tokens but never emitted a completion
				if (!emittedCompletion && allTokens.length > 0) {
					if (parser) {
						const flushEvents = parser.flush();
						for (const event of flushEvents) {
							await self._handleParserEvent(event, finishCallback, allTokens, completedToolCalls, plainTextParts, (t) => { thinkingText += t; });
						}

						const hasDetectedToolCalls = completedToolCalls.length > 0;
						const finishReason = hasDetectedToolCalls
							? FinishedCompletionReason.ToolCalls
							: (truncated ? FinishedCompletionReason.Length : FinishedCompletionReason.Stop);

						const fullText = plainTextParts.join('');
						if (hasDetectedToolCalls) {
							await finishCallback(fullText, 0, {
								text: '',
								copilotToolCalls: completedToolCalls,
							});
						}
						self._emitCompletion(emitter, fullText, allTokens, inputTokens, outputTokens, requestId, finishReason, telemetryData);
					} else {
						const fullText = allTokens.join('');
						const reason = truncated ? FinishedCompletionReason.Length : FinishedCompletionReason.Stop;
						self._emitCompletion(emitter, fullText, allTokens, inputTokens, outputTokens, requestId, reason, telemetryData);
					}
					emittedCompletion = true;
				}

			} catch (err) {
				logService.error(`[stackcode] Error processing Stackspot SSE stream: ${err}`);
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
	 * Handles a parser event and emits appropriate FinishedCallback deltas.
	 * Returns true if truncation was requested.
	 */
	private async _handleParserEvent(
		event: import('../../stackspot/toolCallParser').ToolCallParserEvent,
		finishCallback: FinishedCallback,
		allTokens: string[],
		completedToolCalls: Array<{ name: string; arguments: string; id: string }>,
		plainTextParts: string[],
		addThinking: (text: string) => void,
	): Promise<boolean> {
		switch (event.kind) {
			case ToolCallParserEventKind.Text: {
				// Suppress text when tool calls have been detected — it's typically
				// a redundant confirmation like "I'll create the file for you" that
				// the working fork also suppresses.
				if (completedToolCalls.length > 0) {
					return false;
				}
				plainTextParts.push(event.text);
				const fullText = plainTextParts.join('');
				const truncateAt = await finishCallback(fullText, 0, { text: event.text });
				return truncateAt !== undefined;
			}

			case ToolCallParserEventKind.ToolCallBegin: {
				// Tool call started — emit beginToolCalls delta
				await finishCallback(plainTextParts.join(''), 0, {
					text: '',
					beginToolCalls: [{ name: event.name, id: event.id }],
				});
				return false;
			}

			case ToolCallParserEventKind.ToolCallArgumentsDelta: {
				// Tool call arguments streaming — emit copilotToolCallStreamUpdates delta
				await finishCallback(plainTextParts.join(''), 0, {
					text: '',
					copilotToolCallStreamUpdates: [{
						name: event.name,
						arguments: event.argumentsDelta,
						id: event.id,
					}],
				});
				return false;
			}

			case ToolCallParserEventKind.ToolCallComplete: {
				// Tool call complete — store it (will be emitted in final delta)
				completedToolCalls.push({
					name: event.toolCall.name,
					arguments: event.toolCall.arguments,
					id: event.toolCall.id,
				});
				return false;
			}

			case ToolCallParserEventKind.Thinking: {
				// Thinking text — emit as thinking delta
				addThinking(event.text);
				await finishCallback(plainTextParts.join(''), 0, {
					text: '',
					thinking: { text: event.text },
				});
				return false;
			}

			default:
				return false;
		}
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
	 *
	 * Uses a structured XML prompt format matching the working fork:
	 * <prompt>
	 *   <system>...</system>          — system messages
	 *   <tools>...</tools>            — tool definitions (Agent mode)
	 *   <workspace>...</workspace>    — workspace path info
	 *   <history>                     — conversation history
	 *     <user>...</user>
	 *     <assistant>...</assistant>   — may contain <tool_call> tags
	 *     <tool>...</tool>            — contains <tool_result> tags
	 *   </history>
	 *   <system>[FORMAT REMINDER]</system>
	 * </prompt>
	 */
	private _convertMessagesToUserPrompt(
		messages: Raw.ChatMessage[],
		tools?: OpenAiFunctionTool[],
	): string {
		const hasTools = tools && tools.length > 0;
		const promptSections: string[] = [];

		// ── System messages ────────────────────────────────────────────
		const systemParts: string[] = [];
		const historyMessages: Raw.ChatMessage[] = [];

		for (const message of messages) {
			if (message.role === Raw.ChatRole.System) {
				const text = getTextPart(message.content);
				if (text.trim()) {
					systemParts.push(text.trim());
				}
			} else {
				historyMessages.push(message);
			}
		}

		if (systemParts.length > 0) {
			promptSections.push(`<system>\n${systemParts.join('\n\n')}\n</system>`);
		}

		// ── Tool definitions (Agent mode) ──────────────────────────────
		if (hasTools) {
			const toolDefs = formatToolDefinitionsForPrompt(tools);
			const toolPrompt = getToolCallingSystemPrompt(toolDefs);
			promptSections.push(`<tools>\n${toolPrompt}\n</tools>`);
		}

		// ── Workspace info ─────────────────────────────────────────────
		// The workspace root is not available at this level, but the system
		// prompt from prompt-tsx typically includes it. We add a generic
		// instruction about absolute paths that the LLM should follow.
		if (hasTools) {
			promptSections.push(
				'<workspace>\n' +
				'CRITICAL: ALL file paths in tool calls MUST be absolute paths.\n' +
				'NEVER use relative paths like "src/file.js" — ALWAYS use the full absolute path.\n' +
				'</workspace>'
			);
		}

		// ── History (user/assistant/tool messages) ─────────────────────
		if (historyMessages.length > 0) {
			const historyParts: string[] = [];

			for (const message of historyMessages) {
				switch (message.role) {
					case Raw.ChatRole.User: {
						const text = getTextPart(message.content);
						if (text.trim()) {
							historyParts.push(`<user>\n${text.trim()}\n</user>`);
						}
						break;
					}

					case Raw.ChatRole.Assistant: {
						const segments: string[] = [];
						const text = getTextPart(message.content);
						if (text.trim()) {
							segments.push(text.trim());
						}

						// Serialize tool calls made by the assistant in this turn
						const assistantMsg = message as Raw.AssistantChatMessage;
						if (assistantMsg.toolCalls && assistantMsg.toolCalls.length > 0) {
							for (const tc of assistantMsg.toolCalls) {
								const name = tc.function.name;
								const params = tc.function.arguments; // Already a JSON string
								const id = tc.id;
								segments.push(`<tool_call id="${id}" tool="${name}">\n${params}\n</tool_call>`);
							}
						}

						if (segments.length > 0) {
							historyParts.push(`<assistant>\n${segments.join('\n')}\n</assistant>`);
						}
						break;
					}

					case Raw.ChatRole.Tool: {
						const toolMsg = message as Raw.ToolChatMessage;
						const text = getTextPart(message.content);
						const toolCallId = toolMsg.toolCallId ?? 'unknown';
						// Tool results are not errors unless indicated in the content
						const isError = text.toLowerCase().includes('error') || text.toLowerCase().includes('failed');
						historyParts.push(`<tool>\n<tool_result id="${toolCallId}" error="${isError}">\n${text.trim()}\n</tool_result>\n</tool>`);
						break;
					}

					default:
						break;
				}
			}

			if (historyParts.length > 0) {
				promptSections.push(`<history>\n${historyParts.join('\n\n')}\n</history>`);
			}
		}

		// ── Format reminder (injected LAST when tools are present) ─────
		if (hasTools) {
			promptSections.push(`<system>\n${FORMAT_REMINDER_INSTRUCTION}\n</system>`);
		}

		return `<prompt>\n${promptSections.join('\n\n')}\n</prompt>`;
	}
}
