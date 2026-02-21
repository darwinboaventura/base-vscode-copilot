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
	/** The underlying LLM model name (e.g. 'gpt-5.1', 'gpt-4.1', 'sonnet4.5') */
	llmModel?: string;
	/** Whether this agent is used for interactive chat */
	forChat?: boolean;
	/** Whether this agent is used for code completions */
	forCompletions?: boolean;
	/** Whether this agent is used for AI support features (e.g. rename, explain) */
	forAISupportFeatures?: boolean;
}

/**
 * Configuration for a specific Stackspot realm.
 */
export interface StackspotRealmConfig {
	realm: string;
	displayName: string;
	agents: StackspotAgent[];
}

export interface StackspotChatRequest {
	streaming: boolean;
	user_prompt: string;
	conversation_id?: string;
	stackspot_knowledge?: boolean;
	return_ks_in_response?: boolean;
	deep_search_ks?: boolean;
	/** IDs of files previously uploaded via the Stackspot file-upload API */
	upload_ids?: string[];
}

/**
 * Response from the Stackspot file-upload pre-signed form endpoint.
 * POST https://data-integration-api.stackspot.com/v2/file-upload/form
 */
export interface StackspotUploadFormResponse {
	/** The S3 pre-signed upload URL */
	url: string;
	/** The unique ID for this upload (used in chat request upload_ids) */
	id: string;
	/** S3 pre-signed form fields */
	form: {
		key: string;
		'x-amz-algorithm': string;
		'x-amz-credential': string;
		'x-amz-date': string;
		'x-amz-security-token': string;
		policy: string;
		'x-amz-signature': string;
	};
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
