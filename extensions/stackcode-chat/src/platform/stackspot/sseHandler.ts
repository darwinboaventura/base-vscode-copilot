/**
 * Stackspot AI - SSE Handler
 * 
 * Processa Server-Sent Events da API do Stackspot AI e converte para formato OpenAI
 */

import { StackspotSSEResponse, OpenAIChunk } from './types.js';

export class StackspotSSEHandler {
	private buffer: string = '';
	private conversationId: string = '';
	private messageId: string = '';
	private inputTokens: number = 0;
	private outputTokens: number = 0;
	private chunkIndex: number = 0;
	private readonly model: string;
	private readonly created: number;

	constructor(model: string = 'stackspot-ai') {
		this.model = model;
		this.created = Math.floor(Date.now() / 1000);
	}

	/**
	 * Processa uma linha SSE e retorna chunks OpenAI se disponíveis
	 */
	processLine(line: string): OpenAIChunk[] {
		this.buffer += line;

		if (!line.startsWith('data: ')) {
			return [];
		}

		const data = line.slice(6).trim();
		
		if (data === '[DONE]') {
			return this.createFinalChunk();
		}

		try {
			const response: StackspotSSEResponse = JSON.parse(data);
			return this.processResponse(response);
		} catch {
			return [];
		}
	}

	private processResponse(response: StackspotSSEResponse): OpenAIChunk[] {
		if (response.stop_reason) {
			this.inputTokens = response.tokens?.input ?? 0;
			this.outputTokens = response.tokens?.output ?? 0;
			this.conversationId = response.conversation_id ?? '';
			this.messageId = response.message_id ?? '';
			return this.createFinalChunk();
		}

		if (!response.message) {
			return [];
		}

		const chunk: OpenAIChunk = {
			id: `chatcmpl-${this.messageId || this.generateId()}`,
			object: 'chat.completion.chunk',
			created: this.created,
			model: this.model,
			choices: [{
				index: 0,
				delta: {
					content: response.message,
					role: this.chunkIndex === 0 ? 'assistant' : undefined
				},
				finish_reason: null
			}]
		};

		this.chunkIndex++;
		return [chunk];
	}

	private createFinalChunk(): OpenAIChunk[] {
		if (this.chunkIndex === 0) {
			return [];
		}

		const finalChunk: OpenAIChunk = {
			id: `chatcmpl-${this.messageId || this.generateId()}`,
			object: 'chat.completion.chunk',
			created: this.created,
			model: this.model,
			choices: [{
				index: 0,
				delta: { content: '' },
				finish_reason: 'stop'
			}],
			usage: {
				prompt_tokens: this.inputTokens,
				completion_tokens: this.outputTokens,
				total_tokens: this.inputTokens + this.outputTokens
			}
		};

		return [finalChunk];
	}

	private generateId(): string {
		return Math.random().toString(36).substring(2, 15);
	}

	getConversationId(): string {
		return this.conversationId;
	}

	reset(): void {
		this.buffer = '';
		this.conversationId = '';
		this.messageId = '';
		this.inputTokens = 0;
		this.outputTokens = 0;
		this.chunkIndex = 0;
	}
}
