/*---------------------------------------------------------------------------------------------
 *  StackCode - Realm-Based Agent Configuration
 *
 *  Hardcoded agent configurations per Stackspot realm. Each realm has its own
 *  set of agents with unique IDs configured in the Stackspot Portal.
 *
 *  Agent categories:
 *  - forChat: Used for interactive chat (Ask/Edit/Agent modes)
 *  - forCompletions: Used for inline code completions (ghost text)
 *  - forAISupportFeatures: Used for auxiliary AI features (rename, explain, etc.)
 *
 *  The first forChat agent in each realm is the default chat model.
 *--------------------------------------------------------------------------------------------*/

import { StackspotRealmConfig } from './types';

/**
 * Registry of all known realm configurations.
 * Add new realms here as they are onboarded.
 */
const REALM_CONFIGS: StackspotRealmConfig[] = [
	{
		realm: 'itau',
		displayName: 'Itau',
		agents: [
			{
				id: '01KDNJ7X6K21MS1Z4G46MEKNNP',
				name: 'GPT 5.1',
				description: 'OpenAI GPT 5.1 - Best for complex reasoning',
				llmModel: 'gpt-5.1',
				forChat: true,
			},
			{
				id: '01KDDKWCDT5WR1R996MSM0Q656',
				name: 'GPT 4.1',
				description: 'OpenAI GPT 4.1 - Fast and intelligent',
				llmModel: 'gpt-4.1',
				forChat: true,
			},
			{
				id: '01KFG701JPY62PQT8GFBHEGE4D',
				name: 'Completion Agent',
				description: 'Completions',
				llmModel: 'gpt-4.1',
				forCompletions: true,
			},
			{
				id: '01KFG701JPY62PQT8GFBHEGE4D',
				name: 'GPT 4.1 (Auxiliary)',
				description: 'OpenAI GPT 4.1 - Fast and intelligent',
				llmModel: 'gpt-4.1',
				forAISupportFeatures: true,
			},
		],
	},
	{
		realm: 'zup',
		displayName: 'Zup',
		agents: [
			{
				id: '01KD1H4TJ53PCTC1YSPAGPJXSG',
				name: 'GPT 5.1',
				description: 'OpenAI GPT 5.1 - Best for complex reasoning',
				llmModel: 'gpt-5.1',
				forChat: true,
			},
			{
				id: '01KD1H4W39D5ZFGGMJ9TN3JEN5',
				name: 'GPT 4.1',
				description: 'OpenAI GPT 4.1 - Fast and intelligent',
				llmModel: 'gpt-4.1',
				forChat: true,
			},
			{
				id: '01KD1H4VBNPVBSADYMTE0GDXEK',
				name: 'Claude Sonnet 4.5',
				description: 'Anthropic Sonnet 4.5 - Fast and intelligent',
				llmModel: 'sonnet4.5',
				forChat: true,
			},
			{
				id: '01KF3EVTTDQ3C7QJHMVT3J604P',
				name: 'Gemini 3',
				description: 'Google Gemini',
				llmModel: 'gemini-3',
				forChat: true,
			},
			{
				id: '01KFC5236SN6F57MHYTRK28JRP',
				name: 'Completion Agent',
				description: 'Completions',
				llmModel: 'gpt-4.1',
				forCompletions: true,
			},
			{
				id: '01KFC5236SN6F57MHYTRK28JRP',
				name: 'GPT 4.1 (Auxiliary)',
				description: 'OpenAI GPT 4.1 - Fast and intelligent',
				llmModel: 'gpt-4.1',
				forAISupportFeatures: true,
			},
		],
	},
];

/**
 * Lookup map for fast realm resolution.
 */
const REALM_MAP = new Map<string, StackspotRealmConfig>(
	REALM_CONFIGS.map(config => [config.realm.toLowerCase(), config])
);

/**
 * Returns the realm configuration for the given realm name.
 * Returns undefined if the realm is not known.
 */
export function getRealmConfig(realm: string): StackspotRealmConfig | undefined {
	return REALM_MAP.get(realm.toLowerCase());
}

/**
 * Returns the chat agents for the given realm (agents with forChat=true).
 * These are the agents available in the model picker for interactive chat.
 */
export function getChatAgents(realm: string): StackspotRealmConfig['agents'] {
	const config = getRealmConfig(realm);
	if (!config) {
		return [];
	}
	return config.agents.filter(a => a.forChat);
}

/**
 * Returns the default chat agent for the given realm.
 * This is the first forChat agent in the realm configuration.
 */
export function getDefaultChatAgent(realm: string): StackspotRealmConfig['agents'][0] | undefined {
	return getChatAgents(realm)[0];
}

/**
 * Returns the completion agent for the given realm (agent with forCompletions=true).
 */
export function getCompletionAgent(realm: string): StackspotRealmConfig['agents'][0] | undefined {
	const config = getRealmConfig(realm);
	if (!config) {
		return undefined;
	}
	return config.agents.find(a => a.forCompletions);
}

/**
 * Returns the auxiliary AI support agent for the given realm.
 */
export function getAISupportAgent(realm: string): StackspotRealmConfig['agents'][0] | undefined {
	const config = getRealmConfig(realm);
	if (!config) {
		return undefined;
	}
	return config.agents.find(a => a.forAISupportFeatures);
}

/**
 * Returns all known realm names.
 */
export function getKnownRealms(): string[] {
	return Array.from(REALM_MAP.keys());
}
