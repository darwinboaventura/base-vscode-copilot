/*---------------------------------------------------------------------------------------------
 *  StackCode — Stackspot AI Completions Fetch Service
 *
 *  Overrides ICompletionsFetchService to intercept inline completion requests
 *  (ghost text) that would normally go to the OpenAI-format endpoint
 *  (e.g. /v1/engines/{model}/completions) and route them through the
 *  Stackspot AI Agent Chat API instead.
 *
 *  The original CompletionsFetchService sends requests directly to the URL
 *  constructed by getProxyEngineUrl(), which produces a URL like:
 *    https://genai-inference-app.stackspot.com/v1/engines/gpt-41-copilot/completions
 *  This endpoint does NOT exist in Stackspot AI.
 *
 *  This service detects the Stackspot proxy URL pattern and:
 *  1. Gets the realm's Completion Agent ID via getCompletionAgent(realm)
 *  2. Converts the OpenAI CompletionRequest to Stackspot format
 *  3. Replaces URL with Stackspot Agent Chat endpoint
 *  4. Adds proper Stackspot OAuth2 Authorization header
 *  5. Parses Stackspot SSE responses back into Completion objects
 *
 *  For non-Stackspot URLs, it delegates to the original CompletionsFetchService.
 *--------------------------------------------------------------------------------------------*/

import { AsyncIterUtilsExt } from '../../../util/common/asyncIterableUtils';
import * as errors from '../../../util/common/errors';
import { Result } from '../../../util/common/result';
import { CancellationToken } from '../../../util/vs/base/common/cancellation';
import { IDisposable } from '../../../util/vs/base/common/lifecycle';
import { IAuthenticationService } from '../../authentication/common/authentication';
import { ICopilotTokenManager } from '../../authentication/common/copilotTokenManager';
import { StackspotCopilotTokenManager } from '../../authentication/vscode-node/stackspotCopilotTokenManager';
import { getRequestId } from '../../networking/common/fetch';
import { FetchOptions, IFetcherService } from '../../networking/common/fetcherService';
import { ILogService } from '../../log/common/logService';
import { IRequestLogger, LoggedRequestKind } from '../../requestLogger/node/requestLogger';
import { getCompletionAgent } from '../../stackspot/realmAgents';
import { StackspotAuthService } from '../../stackspot/auth';
import { Completion } from '../common/completionsAPI';
import { Completions, ICompletionsFetchService } from '../common/completionsFetchService';
import { ResponseStream } from '../common/responseStream';

const STACKSPOT_HOST = 'genai-inference-app.stackspot.com';
const STACKSPOT_AGENT_CHAT_BASE = `https://${STACKSPOT_HOST}/v1/agent`;

export class StackspotCompletionsFetchService implements ICompletionsFetchService {
	readonly _serviceBrand: undefined;

	constructor(
		@IAuthenticationService _authService: IAuthenticationService,
		@IFetcherService private readonly fetcherService: IFetcherService,
		@IRequestLogger private readonly requestLogger: IRequestLogger,
		@ICopilotTokenManager private readonly tokenManager: ICopilotTokenManager,
		@ILogService private readonly logService: ILogService,
	) { }

	public disconnectAll(): Promise<unknown> {
		return this.fetcherService.disconnectAll();
	}

	public async fetch(
		url: string,
		secretKey: string,
		params: Completions.ModelParams,
		requestId: string,
		ct: CancellationToken,
		headerOverrides?: Record<string, string>,
	): Promise<Result<ResponseStream, Completions.CompletionsFetchFailure>> {
		const startTimeMs = Date.now();

		if (ct.isCancellationRequested) {
			return Result.error(new Completions.RequestCancelled());
		}

		// Detect if this is a Stackspot URL
		if (this._isStackspotUrl(url)) {
			return this._fetchFromStackspot(url, params, requestId, ct, startTimeMs);
		}

		// Fallback: delegate to standard OpenAI-format fetch (shouldn't happen in Stackspot mode)
		this.logService.warn(`[stackcode] CompletionsFetchService: non-Stackspot URL detected, falling back to direct fetch: ${url}`);
		return this._fetchDirect(url, secretKey, params, requestId, ct, headerOverrides, startTimeMs);
	}

	private _isStackspotUrl(url: string): boolean {
		try {
			return new URL(url).hostname === STACKSPOT_HOST;
		} catch {
			return url.includes(STACKSPOT_HOST);
		}
	}

	/**
	 * Intercept and route through Stackspot Agent Chat API.
	 */
	private async _fetchFromStackspot(
		originalUrl: string,
		params: Completions.ModelParams,
		requestId: string,
		ct: CancellationToken,
		startTimeMs: number,
	): Promise<Result<ResponseStream, Completions.CompletionsFetchFailure>> {

		// 1. Get auth service and realm
		const authService = this._getStackspotAuthService();
		if (!authService) {
			this.logService.error('[stackcode] CompletionsFetchService: Cannot get StackspotAuthService');
			return Result.error(new Completions.Unexpected(new Error('Stackspot auth not available')));
		}

		const credentials = authService.getCredentials();
		if (!credentials?.realm) {
			this.logService.error('[stackcode] CompletionsFetchService: No realm in credentials');
			return Result.error(new Completions.Unexpected(new Error('Stackspot realm not configured')));
		}

		// 2. Get completion agent for this realm
		const completionAgent = getCompletionAgent(credentials.realm);
		if (!completionAgent) {
			this.logService.error(`[stackcode] CompletionsFetchService: No completion agent for realm ${credentials.realm}`);
			return Result.error(new Completions.Unexpected(new Error(`No completion agent for realm: ${credentials.realm}`)));
		}

		// 3. Get access token
		let accessToken: string;
		try {
			accessToken = await authService.getAccessToken();
		} catch (e) {
			this.logService.error(`[stackcode] CompletionsFetchService: Failed to get access token: ${e}`);
			return Result.error(new Completions.Unexpected(errors.fromUnknown(e)));
		}

		// 4. Build Stackspot request
		const stackspotUrl = `${STACKSPOT_AGENT_CHAT_BASE}/${completionAgent.id}/chat`;
		const userPrompt = this._buildCompletionPrompt(params);

		const body = JSON.stringify({
			streaming: true,
			user_prompt: userPrompt,
			use_conversation: false,
		});

		this.logService.info(`[stackcode] CompletionsFetchService: Routing inline completion to Stackspot Agent ${completionAgent.name} (${completionAgent.id})`);
		this.logService.debug(`[stackcode] CompletionsFetchService: prompt length=${userPrompt.length}, suffix=${params.suffix ? 'yes' : 'no'}, stop=${JSON.stringify(params.stop)}, max_tokens=${params.max_tokens}`);

		// 5. Fetch from Stackspot
		const fetchAbortCtl = this.fetcherService.makeAbortController();
		const onCancellationDisposable = ct.onCancellationRequested(() => {
			fetchAbortCtl.abort();
		});

		try {
			const fetchOptions: FetchOptions = {
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${accessToken}`,
					'X-Request-Id': requestId,
				},
				body,
				signal: fetchAbortCtl.signal,
				method: 'POST',
			};

			const response = await this.fetcherService.fetch(stackspotUrl, fetchOptions);

			if (response.status !== 200) {
				const error = new Completions.UnsuccessfulResponse(
					response.status,
					response.statusText,
					response.headers,
					() => response.text().catch(() => ''),
				);
				this.logService.error(`[stackcode] CompletionsFetchService: Stackspot returned ${response.status} ${response.statusText}`);
				this._logRequest(originalUrl, stackspotUrl, params, requestId, startTimeMs, Result.error(error));
				return Result.error(error);
			}

			// 6. Parse Stackspot SSE → Completion stream
			const textStream = response.body.pipeThrough(new TextDecoderStream());
			const cleanStream = streamWithCleanup(textStream, onCancellationDisposable);
			const lineStream = AsyncIterUtilsExt.splitLines(cleanStream);
			const completionsStream = stackspotSSEToCompletions(lineStream);

			// Create a synthetic RequestId from Stackspot headers
			const reqId = getRequestId(response.headers);

			const responseStream = new ResponseStream(response, completionsStream, reqId, response.headers);

			const result = Result.ok(responseStream);
			this._logRequest(originalUrl, stackspotUrl, params, requestId, startTimeMs, result);
			return result;

		} catch (reason: unknown) {
			onCancellationDisposable.dispose();

			if (reason instanceof Error && reason.message === 'This operation was aborted') {
				return Result.error(new Completions.RequestCancelled());
			}

			const error = errors.fromUnknown(reason);
			this.logService.error(`[stackcode] CompletionsFetchService: Fetch error: ${error.message}`);
			return Result.error(new Completions.Unexpected(error));
		}
	}

	/**
	 * Build the user_prompt for completions.
	 * Combines the prefix/suffix into a FIM (Fill-in-the-Middle) prompt.
	 *
	 * IMPORTANT: We do NOT wrap code in markdown fences because the model
	 * would mirror them back in the response, polluting the completion text.
	 * We use explicit delimiters (<|prefix|>, <|suffix|>, <|cursor|>) that
	 * the model can recognise but won't echo.
	 */
	private _buildCompletionPrompt(params: Completions.ModelParams): string {
		const prefix = params.prompt || '';
		const suffix = params.suffix || '';

		// Determine stop hint based on params.stop
		const stopHint = params.stop && params.stop.length > 0
			? `\nSTOP generating when you reach any of these sequences: ${JSON.stringify(params.stop)}`
			: '';

		// Determine max_tokens hint
		const maxTokensHint = params.max_tokens
			? `\nGenerate at most ${params.max_tokens} tokens.`
			: '';

		if (suffix) {
			return [
				'You are an inline code completion engine. You output ONLY raw code, never explanations, never markdown, never code fences.',
				'Fill in the code at <|cursor|>. Output ONLY the inserted code — do not repeat the prefix or suffix.',
				'Do not wrap your response in ``` or any other formatting. Output plain code only.',
				stopHint,
				maxTokensHint,
				'',
				'<|prefix|>',
				prefix,
				'<|cursor|>',
				suffix,
				'<|suffix|>',
			].filter(l => l !== undefined).join('\n');
		}

		return [
			'You are an inline code completion engine. You output ONLY raw code, never explanations, never markdown, never code fences.',
			'Continue the code below. Output ONLY the continuation — do not repeat any of the existing code.',
			'Do not wrap your response in ``` or any other formatting. Output plain code only.',
			stopHint,
			maxTokensHint,
			'',
			'<|prefix|>',
			prefix,
			'<|cursor|>',
		].filter(l => l !== undefined).join('\n');
	}

	/**
	 * Resolve StackspotAuthService from the token manager.
	 */
	private _getStackspotAuthService(): StackspotAuthService | undefined {
		if (this.tokenManager instanceof StackspotCopilotTokenManager) {
			return this.tokenManager.getAuthService();
		}
		return undefined;
	}

	/**
	 * Fallback: direct OpenAI-format fetch (for non-Stackspot URLs).
	 */
	private async _fetchDirect(
		url: string,
		secretKey: string,
		params: Completions.ModelParams,
		requestId: string,
		ct: CancellationToken,
		headerOverrides: Record<string, string> | undefined,
		startTimeMs: number,
	): Promise<Result<ResponseStream, Completions.CompletionsFetchFailure>> {
		const fetchAbortCtl = this.fetcherService.makeAbortController();
		const onCancellationDisposable = ct.onCancellationRequested(() => {
			fetchAbortCtl.abort();
		});

		try {
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
				'x-policy-id': 'nil',
				Authorization: 'Bearer ' + secretKey,
				'X-Request-Id': requestId,
				'X-GitHub-Api-Version': '2025-04-01',
				...headerOverrides,
			};

			const request: FetchOptions = {
				headers,
				body: JSON.stringify({ ...params, stream: true }),
				signal: fetchAbortCtl.signal,
				method: 'POST',
			};

			const response = await this.fetcherService.fetch(url, request);

			if (response.status !== 200) {
				return Result.error(new Completions.UnsuccessfulResponse(
					response.status,
					response.statusText,
					response.headers,
					() => response.text().catch(() => ''),
				));
			}

			const body = response.body.pipeThrough(new TextDecoderStream());
			const responseStream = streamWithCleanup(body, onCancellationDisposable);
			const jsonlStream = AsyncIterUtilsExt.splitLines(responseStream);
			const completionsStream = jsonlStreamToCompletions(jsonlStream);

			const reqId = getRequestId(response.headers);
			const rs = new ResponseStream(response, completionsStream, reqId, response.headers);
			return Result.ok(rs);

		} catch (reason: unknown) {
			onCancellationDisposable.dispose();
			if (reason instanceof Error && reason.message === 'This operation was aborted') {
				return Result.error(new Completions.RequestCancelled());
			}
			return Result.error(new Completions.Unexpected(errors.fromUnknown(reason)));
		}
	}

	private _logRequest(
		originalUrl: string,
		actualUrl: string,
		params: Completions.ModelParams,
		requestId: string,
		startTimeMs: number,
		result: Result<ResponseStream, Completions.CompletionsFetchFailure>,
	): void {
		const durationMs = Date.now() - startTimeMs;
		const status = result.isOk() ? 'success' : 'failed';
		const lines: string[] = [];
		lines.push(`# Stackspot Completions`);
		lines.push(``);
		lines.push(`## Metadata`);
		lines.push(`<pre><code>`);
		lines.push(`originalUrl      : ${originalUrl}`);
		lines.push(`stackspotUrl     : ${actualUrl}`);
		lines.push(`requestId        : ${requestId}`);
		lines.push(`duration         : ${durationMs}ms`);
		lines.push(`status           : ${status}`);
		lines.push(`</code></pre>`);

		this.requestLogger.addEntry({
			type: LoggedRequestKind.MarkdownContentRequest,
			debugName: 'Stackspot Completions',
			startTimeMs,
			icon: undefined,
			markdownContent: lines.join('\n'),
		});
	}
}

/**
 * Converts Stackspot SSE stream to Completion objects.
 *
 * Stackspot SSE format:
 *   data: {"message": "token_text", "stop_reason": null, ...}
 *   data: {"message": "", "stop_reason": "stop", ...}
 *
 * Because the Stackspot Agent Chat API is a chat endpoint (not a FIM endpoint),
 * the model may wrap its response in markdown code fences or add conversational
 * preambles. We accumulate ALL tokens, then on the final chunk emit a single
 * Completion with the cleaned text.
 *
 * Why accumulate-then-emit instead of streaming individual tokens?
 * The upstream `convertStreamToApiChoices` concatenates `choice.text` from
 * every Completion into `responseSoFar`. If we emitted intermediate tokens
 * AND then a cleaned full-text final chunk, the accumulated text would be
 * duplicated. By emitting a single Completion at the end, `responseSoFar`
 * equals exactly the cleaned text, and `finish_reason: 'stop'` triggers
 * immediate yield of the APIChoice.
 */
async function* stackspotSSEToCompletions(lineStream: AsyncIterable<string>): AsyncGenerator<Completion> {
	let accumulatedText = '';
	let lastTokens: { input?: number; output?: number } | undefined;

	for await (const line of lineStream) {
		const trimmed = line.trim();

		if (trimmed === '' || trimmed === 'data: [DONE]') {
			continue;
		}

		if (!trimmed.startsWith('data: ')) {
			continue;
		}

		const jsonStr = trimmed.substring('data: '.length);

		let parsed: {
			message?: string;
			stop_reason?: string | null;
			tokens?: { input?: number; output?: number };
			conversation_id?: string;
			message_id?: string;
		};

		try {
			parsed = JSON.parse(jsonStr);
		} catch {
			// Skip malformed lines
			continue;
		}

		const text = parsed.message || '';
		accumulatedText += text;

		const isLast = parsed.stop_reason != null && parsed.stop_reason !== '';

		if (isLast) {
			lastTokens = parsed.tokens;

			// Clean the accumulated text (strip markdown fences etc.)
			const cleanedText = stripMarkdownFences(accumulatedText);

			const completion: Completion = {
				choices: [{
					index: 0,
					finish_reason: Completion.FinishReason.Stop,
					text: cleanedText,
				}],
				system_fingerprint: 'stackspot',
				object: 'text_completion',
				usage: lastTokens ? {
					prompt_tokens: lastTokens.input ?? 0,
					completion_tokens: lastTokens.output ?? 0,
					total_tokens: (lastTokens.input ?? 0) + (lastTokens.output ?? 0),
					completion_tokens_details: { audio_tokens: 0, reasoning_tokens: 0 },
					prompt_tokens_details: { audio_tokens: 0, reasoning_tokens: 0 },
				} : undefined,
			};
			yield completion;
		}
	}

	// If the stream ended without a stop_reason (abnormal), emit what we have
	if (accumulatedText.length > 0 && !lastTokens) {
		const cleanedText = stripMarkdownFences(accumulatedText);
		if (cleanedText.length > 0) {
			const completion: Completion = {
				choices: [{
					index: 0,
					finish_reason: Completion.FinishReason.Stop,
					text: cleanedText,
				}],
				system_fingerprint: 'stackspot',
				object: 'text_completion',
				usage: undefined,
			};
			yield completion;
		}
	}
}

/**
 * Strips markdown code fences and conversational preambles from model output.
 *
 * The Stackspot Agent Chat API is a chat model, not a FIM model. Despite
 * prompt instructions, it may wrap responses in:
 *   ```language\n...\n```
 *   or just ```\n...\n```
 *   or add "Here is the completion:" preambles
 *
 * This function extracts the raw code from the response.
 */
function stripMarkdownFences(text: string): string {
	// 1. Try to extract content inside a single code fence block
	const fenceMatch = text.match(/^[^\S\n]*```[^\n]*\n([\s\S]*?)\n[^\S\n]*```[^\S\n]*$/m);
	if (fenceMatch) {
		return fenceMatch[1];
	}

	// 2. Handle case where response starts with ``` (opening fence) but
	//    the closing fence might be the last line
	const startFence = /^[^\S\n]*```[^\n]*\n/;
	const endFence = /\n[^\S\n]*```[^\S\n]*$/;
	if (startFence.test(text) && endFence.test(text)) {
		return text.replace(startFence, '').replace(endFence, '');
	}

	// 3. Handle case where model just starts with ``` on the first line
	if (text.startsWith('```')) {
		const firstNewline = text.indexOf('\n');
		if (firstNewline !== -1) {
			let cleaned = text.substring(firstNewline + 1);
			// Remove trailing fence if present
			if (cleaned.trimEnd().endsWith('```')) {
				cleaned = cleaned.replace(/\n?```\s*$/, '');
			}
			return cleaned;
		}
	}

	return text;
}

/**
 * Standard OpenAI JSONL → Completion parser (for fallback path).
 */
async function* jsonlStreamToCompletions(jsonlStream: AsyncIterable<string>): AsyncGenerator<Completion> {
	for await (const line of jsonlStream) {
		if (line.trim() === 'data: [DONE]') {
			continue;
		}
		if (line.startsWith('data: ')) {
			const message: Completion & { error?: { message: string } } = JSON.parse(line.substring('data: '.length));
			if (message.error) {
				throw new Error(message.error.message);
			}
			yield message;
		}
	}
}

/**
 * Wraps an async iterable stream and disposes the cleanup disposable when the stream completes or errors.
 */
async function* streamWithCleanup(
	stream: AsyncIterable<string>,
	cleanupDisposable: IDisposable
): AsyncGenerator<string> {
	try {
		for await (const str of stream) {
			yield str;
		}
	} catch (err: unknown) {
		const error = errors.fromUnknown(err);
		throw error;
	} finally {
		cleanupDisposable.dispose();
	}
}
