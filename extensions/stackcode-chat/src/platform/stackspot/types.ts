/**
 * Stackspot AI - Tipos e Interfaces
 * 
 * Define os tipos necessários para a comunicação com a API do Stackspot AI
 */

export interface StackspotCredentials {
	realm: string;
	clientId: string;
	clientKey: string;
}

export interface StackspotTokenResponse {
	access_token: string;
	token_type: string;
	expires_in: number;
}

export interface StackspotAgent {
	id: string;
	name: string;
	description?: string;
}

export interface StackspotChatRequest {
	streaming: boolean;
	user_prompt: string;
	conversation_id?: string;
	stackspot_knowledge?: boolean;
	return_ks_in_response?: boolean;
	deep_search_ks?: boolean;
}

export interface StackspotSSEResponse {
	message?: string;
	stop_reason?: string;
	tokens?: {
		user: number | null;
		enrichment: number | null;
		input: number;
		output: number;
	};
	upload_ids?: Record<string, unknown>;
	knowledge_source_id?: string[];
	source?: string[];
	cross_account_source?: string[];
	tools_id?: string[];
	agent_info?: unknown[];
	conversation_id?: string;
	message_id?: string;
}

export interface OpenAIMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	name?: string;
	tool_call_id?: string;
}

export interface OpenAIChatRequest {
	model: string;
	messages: OpenAIMessage[];
	stream?: boolean;
	temperature?: number;
	max_tokens?: number;
	top_p?: number;
	stop?: string | string[];
	tools?: unknown[];
}

export interface OpenAIChunk {
	id: string;
	object: string;
	created: number;
	model: string;
	choices: {
		index: number;
		delta: {
			content: string;
			role?: string;
		};
		finish_reason: string | null;
	}[];
	usage?: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
	};
}

export interface StackspotAvailableModels {
	agents: StackspotAgent[];
	models: string[];
}
