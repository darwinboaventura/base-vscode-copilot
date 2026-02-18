/*---------------------------------------------------------------------------------------------
 *  StackCode - Stackspot AI Endpoint Provider
 *
 *  Replaces ProductionEndpointProvider to route all chat requests through
 *  Stackspot AI agents instead of GitHub Copilot CAPI models.
 *
 *  Key differences from ProductionEndpointProvider:
 *  - No ModelMetadataFetcher (no /models API call to CAPI)
 *  - Hardcoded agent list per realm (agents are configured in Stackspot Portal)
 *  - Creates StackspotChatEndpoint instead of CopilotChatEndpoint
 *  - No embeddings support (Stackspot has no embeddings API)
 *--------------------------------------------------------------------------------------------*/

import type { LanguageModelChat, ChatRequest } from 'vscode';
import { ICopilotTokenManager } from '../../../platform/authentication/common/copilotTokenManager';
import { StackspotCopilotTokenManager } from '../../../platform/authentication/vscode-node/stackspotCopilotTokenManager';
import {
	ChatEndpointFamily,
	EmbeddingsEndpointFamily,
	IChatModelInformation,
	ICompletionModelInformation,
	IEndpointProvider,
} from '../../../platform/endpoint/common/endpointProvider';
import { StackspotChatEndpoint } from '../../../platform/endpoint/node/stackspotChatEndpoint';
import { ILogService } from '../../../platform/log/common/logService';
import { IChatEndpoint, IEmbeddingsEndpoint } from '../../../platform/networking/common/networking';
import { StackspotAgent } from '../../../platform/stackspot/types';
import { TokenizerType } from '../../../util/common/tokenizer';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';


/**
 * Default agents available in Stackspot AI.
 * These are hardcoded because Stackspot has no /models API.
 * Agent IDs are configured in the Stackspot Portal per realm.
 *
 * TODO: Make this configurable per realm via settings or auto-discovery.
 */
const DEFAULT_STACKSPOT_AGENTS: StackspotAgent[] = [
	{ id: 'gpt-4o', name: 'GPT-4o', description: 'Primary model' },
	{ id: 'gpt-4o-mini', name: 'GPT-4o Mini', description: 'Fast model' },
	{ id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', description: 'Anthropic model' },
];

/**
 * Converts a StackspotAgent to IChatModelInformation (the metadata format
 * that ChatEndpoint expects in its constructor).
 */
function agentToModelInfo(agent: StackspotAgent, isDefault: boolean): IChatModelInformation {
	return {
		id: agent.id,
		name: agent.name,
		version: '1.0.0',
		model_picker_enabled: true,
		is_chat_default: isDefault,
		is_chat_fallback: isDefault,
		capabilities: {
			type: 'chat',
			family: 'stackspot',
			tokenizer: TokenizerType.O200K,
			limits: {
				max_prompt_tokens: 128000,
				max_output_tokens: 16384,
			},
			supports: {
				streaming: true,
				tool_calls: false,
				vision: false,
				prediction: false,
			},
		},
	};
}

export class StackspotEndpointProvider extends Disposable implements IEndpointProvider {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidModelsRefresh = this._register(new Emitter<void>());
	readonly onDidModelsRefresh: Event<void> = this._onDidModelsRefresh.event;

	private _chatEndpoints: Map<string, IChatEndpoint> = new Map();
	private readonly _agents: StackspotAgent[];

	constructor(
		_collectFetcherTelemetry: (...args: any[]) => void,
		@ILogService private readonly _logService: ILogService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ICopilotTokenManager private readonly _tokenManager: ICopilotTokenManager,
	) {
		super();
		this._agents = DEFAULT_STACKSPOT_AGENTS;

		this._logService.info('[stackcode] StackspotEndpointProvider initialized');
	}

	/**
	 * Returns the StackspotAuthService from the token manager, or undefined.
	 */
	private get _stackspotAuth() {
		if (this._tokenManager instanceof StackspotCopilotTokenManager) {
			return (this._tokenManager as StackspotCopilotTokenManager).getAuthService();
		}
		return undefined;
	}

	private async _getOrCreateChatEndpoint(agentId: string): Promise<IChatEndpoint> {
		let endpoint = this._chatEndpoints.get(agentId);
		if (!endpoint) {
			const agent = this._agents.find(a => a.id === agentId);
			if (!agent) {
				throw new Error(`[stackcode] Unknown Stackspot agent: ${agentId}`);
			}

			const auth = this._stackspotAuth;
			if (!auth) {
				throw new Error('[stackcode] StackspotAuthService not available');
			}

			const isDefault = agentId === this._agents[0].id;
			const modelInfo = agentToModelInfo(agent, isDefault);

			// Store the access token on modelMetadata so getExtraHeaders() can access it synchronously
			try {
				const accessToken = await auth.getAccessToken();
				(modelInfo as any)._stackspotAccessToken = accessToken;
			} catch (e) {
				this._logService.error(`[stackcode] Failed to get access token for endpoint: ${e}`);
			}

			endpoint = this._instantiationService.createInstance(
				StackspotChatEndpoint,
				modelInfo,
				auth,
				agentId,
			);
			this._chatEndpoints.set(agentId, endpoint);
		} else {
			// Refresh the access token on the existing endpoint
			const auth = this._stackspotAuth;
			if (auth) {
				try {
					const accessToken = await auth.getAccessToken();
					(endpoint as StackspotChatEndpoint).modelMetadata && ((endpoint as any).modelMetadata._stackspotAccessToken = accessToken);
				} catch {
					// Token refresh failed, will be caught at request time
				}
			}
		}
		return endpoint;
	}

	async getChatEndpoint(requestOrFamilyOrModel: LanguageModelChat | ChatRequest | ChatEndpointFamily): Promise<IChatEndpoint> {
		this._logService.trace('[stackcode] Resolving Stackspot chat endpoint');

		let agentId: string;

		if (typeof requestOrFamilyOrModel === 'string') {
			// Family string — map to first agent (all go through Stackspot)
			agentId = this._agents[0].id;
		} else {
			// ChatRequest or LanguageModelChat
			const model = 'model' in requestOrFamilyOrModel ? requestOrFamilyOrModel.model : requestOrFamilyOrModel;
			if (model && 'id' in model) {
				// Try to find a matching agent
				const matchingAgent = this._agents.find(a => a.id === model.id);
				agentId = matchingAgent?.id ?? this._agents[0].id;
			} else {
				agentId = this._agents[0].id;
			}
		}

		const endpoint = await this._getOrCreateChatEndpoint(agentId);
		this._logService.trace(`[stackcode] Resolved Stackspot endpoint: ${agentId}`);
		return endpoint;
	}

	async getAllChatEndpoints(): Promise<IChatEndpoint[]> {
		const endpoints: IChatEndpoint[] = [];
		for (const agent of this._agents) {
			endpoints.push(await this._getOrCreateChatEndpoint(agent.id));
		}
		return endpoints;
	}

	async getAllCompletionModels(_forceRefresh?: boolean): Promise<ICompletionModelInformation[]> {
		// Stackspot has no completion models (only chat via agents)
		return [];
	}

	async getEmbeddingsEndpoint(_family?: EmbeddingsEndpointFamily): Promise<IEmbeddingsEndpoint> {
		throw new Error('[stackcode] Embeddings are not supported by Stackspot AI');
	}
}
