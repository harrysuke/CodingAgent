import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { Platform } from '@codingagent/shared';
import { resolveCredential } from '../db/repo';
import { resolveEndpoint } from './providers';

export interface ResolvedModel {
  model: LanguageModel;
  platform: Platform;
  modelId: string;
}

/** Build an AI SDK language model from this account's key ring. */
export function resolveModel(platform: Platform, modelId: string, userId: string): ResolvedModel {
  const credential = resolveCredential(platform, userId);
  if (!credential) {
    throw new Error(
      `No enabled API key for "${platform}" on your account. CodingAgent is BYOK: ` +
      'add your own key in Settings > Providers & keys, then pick a model from that provider.',
    );
  }
  const endpoint = resolveEndpoint(platform, credential.apiKey, platform === 'custom' ? credential.baseUrl : undefined);
  const provider = createOpenAICompatible({
    name: platform,
    baseURL: endpoint.baseUrl,
    apiKey: endpoint.apiKey || 'no-key',
    headers: endpoint.headers,
  });
  return { model: provider.chatModel(modelId), platform, modelId };
}

/** True when this account has a usable credential for the platform. */
export function canUse(platform: Platform, userId: string): boolean {
  return resolveCredential(platform, userId) !== null;
}
