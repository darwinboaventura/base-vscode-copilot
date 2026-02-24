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
	 * Implementa retry automático com backoff progressivo para lidar com:
	 * - Chunks vazios consecutivos (10+)
	 * - Erros 500/504 da API
	 */
	async *chat(
		request: OpenAIChatRequest,
		signal?: AbortSignal
	): AsyncGenerator<OpenAIChunk, void, unknown> {
		if (!this.selectedAgentId) {
			throw new Error('[stackcode] No agent selected. Call selectAgent() first.');
		}

		const maxRetries = 3;
		const backoffDelays = [1000, 4000, 8000]; // 1s, 4s, 8s
		const maxEmptyLines = 10;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			const attemptController = new AbortController();

			// Link external signal to attempt controller
			if (signal) {
				const abortHandler = () => attemptController.abort();
				signal.addEventListener('abort', abortHandler, { once: true });
				if (signal.aborted) {
					attemptController.abort();
				}
			}

			try {
				const result = await this.executeChatRequest(
					request,
					attemptController.signal,
					maxEmptyLines
				);

				// Yield all chunks from this attempt
				for await (const chunk of result) {
					yield chunk;
				}

				// Se chegamos aqui, a requisição foi bem-sucedida
				return;

			} catch (error) {
				// Verificar se foi abortado externamente
				if (signal?.aborted) {
					throw new Error('[stackcode] Request was cancelled by user');
				}

				const shouldRetry = attempt < maxRetries && this.isRetryableError(error);

				if (!shouldRetry) {
					// Última tentativa falhou ou erro não recuperável
					throw error;
				}

				// Aguardar antes do retry (backoff progressivo)
				const delay = backoffDelays[attempt];
				console.log(`[stackcode] Retry ${attempt + 1}/${maxRetries} after ${delay}ms due to: ${error instanceof Error ? error.message : String(error)}`);
				await this.sleep(delay);
			}
		}
	}

	/**
	 * Verifica se um erro é recuperável (pode fazer retry)
	 */
	private isRetryableError(error: unknown): boolean {
		if (error instanceof Error) {
			const message = error.message.toLowerCase();
			// Retry para linhas SSE vazias consecutivas
			if (message.includes('empty sse lines')) {
				return true;
			}
			// Retry para content timeout
			if (message.includes('content timeout')) {
				return true;
			}
			// Retry para erros 500/504
			if (message.includes('500') || message.includes('504')) {
				return true;
			}
			// Retry para erros de rede/tempo
			if (message.includes('fetch') || message.includes('network') || message.includes('timeout')) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Aguarda um tempo específico em milissegundos
	 */
	private sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	/**
	 * Executa uma requisição de chat com detecção de chunks vazios
	 * Monitora linhas SSE vazias consecutivas e timeout global
	 */
	private async *executeChatRequest(
		request: OpenAIChatRequest,
		signal: AbortSignal,
		maxEmptyLines: number
	): AsyncGenerator<OpenAIChunk, void, unknown> {
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
		let emptyLineCount = 0;
		let lastContentTime = Date.now();
		const CONTENT_TIMEOUT_MS = 30000; // 30s sem conteúdo = timeout

		this.sseHandler.reset();

		try {
			while (true) {
				// Verificar se foi abortado
				if (signal.aborted) {
					throw new Error('[stackcode] Request was cancelled');
				}

				// Verificar timeout global (sem conteúdo por muito tempo)
				if (Date.now() - lastContentTime > CONTENT_TIMEOUT_MS) {
					throw new Error(`[stackcode] Content timeout: no valid content received for ${CONTENT_TIMEOUT_MS}ms, triggering retry`);
				}

				const { done, value } = await reader.read();
				
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					const { chunks, isEmpty } = this.sseHandler.processLine(line);
					
					// Contar linhas vazias consecutivas
					if (isEmpty) {
						emptyLineCount++;
						console.log(`[stackcode] Empty SSE line detected (${emptyLineCount}/${maxEmptyLines})`);
					} else if (chunks.length > 0) {
						// Resetar contador quando recebemos conteúdo válido
						emptyLineCount = 0;
						lastContentTime = Date.now();
					}

					// Detectar muitas linhas vazias consecutivas
					if (emptyLineCount >= maxEmptyLines) {
						throw new Error(`[stackcode] Too many empty SSE lines (${maxEmptyLines}), triggering retry`);
					}

					// Yield todos os chunks válidos
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
