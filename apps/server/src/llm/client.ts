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

/** Build an AI SDK language model from a row in the reused `models` table. */
export function resolveModel(platform: Platform, modelId: string): ResolvedModel {
  const credential = resolveCredential(platform);
  if (!credential) {
    throw new Error(
      `No enabled API key for "${platform}". Add one in Settings > Providers, ` +
      'or pick a model whose provider is already configured.',
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

/** True when the platform has a usable credential (used by the model picker). */
export function canUse(platform: Platform): boolean {
  return resolveCredential(platform) !== null;
}
