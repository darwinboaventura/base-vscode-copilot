/**
 * Stackspot AI - Request Converter
 * 
 * Converte requisições do formato OpenAI/Copilot para o formato Stackspot AI
 */

import { OpenAIMessage, StackspotChatRequest, OpenAIChatRequest } from './types.js';

export class RequestConverter {
	/**
	 * Converte mensagens OpenAI para user_prompt do Stackspot
	 * 
	 * O Stackspot não suporta array de messages, então precisamos
	 * converter tudo para uma única string de prompt
	 */
	static convertMessagesToUserPrompt(
		messages: OpenAIMessage[], 
		includeSystem: boolean = true
	): string {
		const parts: string[] = [];
		
		for (const message of messages) {
			switch (message.role) {
				case 'system':
					if (includeSystem) {
						parts.push(`System: ${message.content}`);
					}
					break;
				case 'user':
					parts.push(`User: ${message.content}`);
					break;
				case 'assistant':
					parts.push(`Assistant: ${message.content}`);
					break;
				case 'tool':
					parts.push(`Tool (${message.tool_call_id}): ${message.content}`);
					break;
			}
		}

		return parts.join('\n\n');
	}

	/**
	 * Converte request OpenAI para request Stackspot
	 */
	static toStackspotRequest(
		openaiRequest: OpenAIChatRequest,
		agentId: string,
		useConversation: boolean = false,
		existingConversationId?: string
	): StackspotChatRequest {
		const userPrompt = this.convertMessagesToUserPrompt(
			openaiRequest.messages,
			true
		);

		const stackspotRequest: StackspotChatRequest = {
			streaming: openaiRequest.stream ?? true,
			user_prompt: userPrompt,
			conversation_id: useConversation ? existingConversationId : undefined,
			stackspot_knowledge: false,
			return_ks_in_response: false,
			deep_search_ks: false
		};

		return stackspotRequest;
	}
}
