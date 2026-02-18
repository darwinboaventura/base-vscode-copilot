/**
 * Stackspot AI Proxy
 * 
 * Proxy local que:
 * 1. Recebe requisições no formato OpenAI/Copilot
 * 2. Converte para o formato Stackspot AI
 * 3. Envia para API do Stackspot AI
 * 4. Converte resposta de volta para formato OpenAI (chunk-by-chunk)
 */

import { OpenAIChatRequest, OpenAIChunk, StackspotAgent } from './types.js';
import { StackspotAuthService } from './auth.js';
import { StackspotSSEHandler } from './sseHandler.js';
import { RequestConverter } from './requestConverter.js';

export type ChunkCallback = (chunk: OpenAIChunk) => void;
export type DoneCallback = (error?: Error) => void;

export class StackspotProxy {
	private authService: StackspotAuthService;
	private sseHandler: StackspotSSEHandler;
	private useConversation: boolean = false;
	private conversationId: string = '';
	private selectedAgentId: string = '';

	constructor() {
		this.authService = new StackspotAuthService();
		this.sseHandler = new StackspotSSEHandler();
	}

	/**
	 * Login com as credenciais do usuário
	 */
	async login(credentials: { realm: string; clientId: string; clientKey: string }): Promise<void> {
		await this.authService.login(credentials);
	}

	/**
	 * Logout
	 */
	logout(): void {
		this.authService.logout();
		this.clearConversation();
	}

	/**
	 * Verifica se está autenticado
	 */
	isAuthenticated(): boolean {
		return this.authService.isAuthenticated();
	}

	/**
	 * Obtém os agents disponíveis
	 */
	getAvailableAgents(): StackspotAgent[] {
		return this.authService.getAvailableModels().agents;
	}

	/**
	 * Seleciona o agent a ser usado
	 */
	selectAgent(agentId: string): void {
		this.selectedAgentId = agentId;
	}

	/**
	 * Obtém o agent selecionado
	 */
	getSelectedAgent(): string {
		return this.selectedAgentId;
	}

	/**
	 * Envia uma requisição de chat para a API do Stackspot AI
	 * Suporta streaming chunk-by-chunk
	 */
	async *chat(
		request: OpenAIChatRequest,
		signal?: AbortSignal
	): AsyncGenerator<OpenAIChunk, void, unknown> {
		if (!this.selectedAgentId) {
			throw new Error('[stackcode] No agent selected. Call selectAgent() first.');
		}

		const endpoint = `https://genai-inference-app.stackspot.com/v1/agent/${this.selectedAgentId}/chat`;
		
		const stackspotRequest = RequestConverter.toStackspotRequest(
			request,
			this.selectedAgentId,
			this.useConversation,
			this.conversationId || undefined
		);

		const authHeader = await this.authService.getAuthHeader();

		const response = await fetch(endpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': authHeader
			},
			body: JSON.stringify(stackspotRequest),
			signal
		});

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`[stackcode] API request failed: ${response.status} - ${error}`);
		}

		if (!response.body) {
			throw new Error('[stackcode] No response body');
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		this.sseHandler.reset();

		try {
			while (true) {
				const { done, value } = await reader.read();
				
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					const chunks = this.sseHandler.processLine(line);
					for (const chunk of chunks) {
						yield chunk;
						
						if (chunk.choices[0]?.finish_reason === 'stop') {
							this.conversationId = this.sseHandler.getConversationId();
						}
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	/**
	 * Versão com callbacks para compatibilidade com código existente
	 */
	async chatWithCallbacks(
		request: OpenAIChatRequest,
		onChunk: ChunkCallback,
		onDone: DoneCallback,
		signal?: AbortSignal
	): Promise<void> {
		try {
			for await (const chunk of this.chat(request, signal)) {
				onChunk(chunk);
			}
			onDone();
		} catch (error) {
			onDone(error instanceof Error ? error : new Error(String(error)));
		}
	}

	/**
	 * Define se deve usar conversation_id (manter contexto no servidor)
	 */
	setUseConversation(use: boolean): void {
		this.useConversation = use;
	}

	/**
	 * Limpa o histórico de conversa
	 */
	clearConversation(): void {
		this.conversationId = '';
		this.sseHandler.reset();
	}

	/**
	 * Fornece o conversation_id atual
	 */
	getConversationId(): string {
		return this.conversationId;
	}
}
