/**
 * Stackspot AI - Authentication Service
 * 
 * Implementa OAuth2 client_credentials para autenticação com Stackspot AI
 * Suporta descoberta de agents disponíveis baseado no realm
 */

import { StackspotCredentials, StackspotTokenResponse, StackspotAvailableModels } from './types.js';
import { getChatAgents, getRealmConfig } from './realmAgents.js';

export class StackspotAuthService {
	private credentials: StackspotCredentials | null = null;
	private accessToken: string | null = null;
	private tokenExpiresAt: number = 0;

	constructor() {}

	/**
	 * Autentica com as credenciais fornecidas
	 */
	async login(credentials: StackspotCredentials): Promise<void> {
		this.credentials = credentials;
		await this.getAccessToken();
	}

	/**
	 * Logout - limpa credenciais e token
	 */
	logout(): void {
		this.credentials = null;
		this.accessToken = null;
		this.tokenExpiresAt = 0;
	}

	/**
	 * Retorna se está autenticado
	 */
	isAuthenticated(): boolean {
		return this.credentials !== null && this.accessToken !== null && Date.now() < this.tokenExpiresAt;
	}

	/**
	 * Retorna as credenciais atuais
	 */
	getCredentials(): StackspotCredentials | null {
		return this.credentials;
	}

	/**
	 * Obtém o access token (com cache e refresh automático)
	 */
	async getAccessToken(): Promise<string> {
		if (!this.credentials) {
			throw new Error('[stackcode] Not authenticated. Call login() first.');
		}

		if (this.accessToken && Date.now() < this.tokenExpiresAt) {
			return this.accessToken;
		}

		const tokenUrl = `https://idm.stackspot.com/${this.credentials.realm}/oidc/oauth/token`;
		console.log('[stackcode] Fetching access token from:', tokenUrl);

		const params = new URLSearchParams({
			grant_type: 'client_credentials',
			client_id: this.credentials.clientId,
			client_secret: this.credentials.clientKey
		});

		// Use AbortController to timeout after 15 seconds
		const controller = new AbortController();
		const timeoutId = setTimeout(() => {
			console.error('[stackcode] Fetch timed out after 15s');
			controller.abort();
		}, 15000);

		try {
			console.log('[stackcode] About to call fetch...');
			const response = await fetch(tokenUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded'
				},
				body: params.toString(),
				signal: controller.signal,
			});
			clearTimeout(timeoutId);
			console.log('[stackcode] Fetch response status:', response.status);

			if (!response.ok) {
				const error = await response.text();
				throw new Error(`[stackcode] Authentication failed: ${response.status} - ${error}`);
			}

			const data = await response.json() as StackspotTokenResponse;

			this.accessToken = data.access_token;
			this.tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
			console.log('[stackcode] Access token obtained successfully, expires in', data.expires_in, 'seconds');

			return this.accessToken;
		} catch (e) {
			clearTimeout(timeoutId);
			console.error('[stackcode] Fetch error:', e);
			throw e;
		}
	}

	/**
	 * Obtém o header de autorização
	 */
	async getAuthHeader(): Promise<string> {
		const token = await this.getAccessToken();
		return `Bearer ${token}`;
	}

	/**
	 * Retorna os agents disponíveis para o realm logado
	 * Usa a configuração hardcoded por realm
	 */
	getAvailableModels(): StackspotAvailableModels {
		if (!this.credentials) {
			throw new Error('[stackcode] Not authenticated');
		}

		const chatAgents = getChatAgents(this.credentials.realm);
		const config = getRealmConfig(this.credentials.realm);

		if (!config || chatAgents.length === 0) {
			console.warn(`[stackcode] No agents configured for realm: ${this.credentials.realm}`);
			return { agents: [], models: [] };
		}

		return {
			agents: chatAgents,
			models: chatAgents.map(a => a.id)
		};
	}
}
