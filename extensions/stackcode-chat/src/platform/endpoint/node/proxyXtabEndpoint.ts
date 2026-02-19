/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ICopilotTokenManager } from '../../authentication/common/copilotTokenManager';
import { StackspotCopilotTokenManager } from '../../authentication/vscode-node/stackspotCopilotTokenManager';
import { CHAT_MODEL } from '../../configuration/common/configurationService';
import { ILogService } from '../../log/common/logService';
import { getCompletionAgent } from '../../stackspot/realmAgents';
import { TokenizerType } from '../../../util/common/tokenizer';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { IChatModelInformation } from '../common/endpointProvider';
import { ChatEndpoint } from './chatEndpoint';
import { StackspotChatEndpoint } from './stackspotChatEndpoint';

export function createProxyXtabEndpoint(
	instaService: IInstantiationService,
	overriddenModelName: string | undefined,
) {
	// ── STACKCODE: Route xtab through Stackspot Completion Agent ──────
	// Resolve ICopilotTokenManager from DI to get the StackspotAuthService
	// and the current realm. Then create a StackspotChatEndpoint using the
	// realm's Completion Agent instead of a ChatEndpoint with ProxyChatCompletions
	// (which would fail with 401 because CAPI proxy doesn't exist).
	try {
		const tokenManager = instaService.invokeFunction(accessor => accessor.get(ICopilotTokenManager));
		if (tokenManager instanceof StackspotCopilotTokenManager) {
			const authService = tokenManager.getAuthService();
			const credentials = authService.getCredentials();
			if (credentials?.realm) {
				const completionAgent = getCompletionAgent(credentials.realm);
				if (completionAgent) {
					const logService = instaService.invokeFunction(accessor => accessor.get(ILogService));
					logService.info(`[stackcode] Creating Stackspot xtab endpoint with Completion Agent: ${completionAgent.name} (${completionAgent.id}) for realm ${credentials.realm}`);

					const modelInfo: IChatModelInformation = {
						id: overriddenModelName ?? CHAT_MODEL.NES_XTAB,
						name: 'xtab-stackspot',
						model_picker_enabled: false,
						is_chat_default: false,
						is_chat_fallback: false,
						version: '1.0.0',
						capabilities: {
							type: 'chat',
							family: 'xtab-stackspot',
							tokenizer: TokenizerType.O200K,
							limits: {
								max_prompt_tokens: 12285,
								max_output_tokens: 4096,
							},
							supports: {
								streaming: true,
								parallel_tool_calls: false,
								tool_calls: false,
								vision: false,
								prediction: true,
							}
						}
					};

					// Store access token on modelMetadata for getExtraHeaders()
					const accessToken = authService.getCachedAccessToken();
					if (accessToken) {
						(modelInfo as any)._stackspotAccessToken = accessToken;
					}

					return instaService.createInstance(
						StackspotChatEndpoint,
						modelInfo,
						authService,
						completionAgent.id,
					);
				}
			}
		}
	} catch {
		// Fallback to original behavior if Stackspot is not available
	}

	// ── Original fallback (should not be reached in Stackspot mode) ───
	const defaultInfo: IChatModelInformation = {
		id: overriddenModelName ?? CHAT_MODEL.NES_XTAB,
		urlOrRequestMetadata: { type: 'ProxyChatCompletions' as any },
		name: 'xtab-proxy',
		model_picker_enabled: false,
		is_chat_default: false,
		is_chat_fallback: false,
		version: 'unknown',
		capabilities: {
			type: 'chat',
			family: 'xtab-proxy',
			tokenizer: TokenizerType.O200K,
			limits: {
				max_prompt_tokens: 12285,
				max_output_tokens: 4096,
			},
			supports: {
				streaming: true,
				parallel_tool_calls: false,
				tool_calls: false,
				vision: false,
				prediction: true,
			}
		}
	};
	return instaService.createInstance(ChatEndpoint, defaultInfo);
}
