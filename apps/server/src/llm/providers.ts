/**
 * Provider registry ported from freellmapi_bak/server/src/providers/index.ts.
 * Every endpoint speaks the OpenAI chat-completions dialect (Google included,
 * via its /v1beta/openai compatibility layer), which lets the Vercel AI SDK's
 * openai-compatible adapter drive all 18 platforms with one implementation.
 */
import type { Platform, ProviderInfo } from '@codingagent/shared';

export interface ProviderDef {
  platform: Platform;
  name: string;
  baseUrl: string;
  keyless: boolean;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Cloudflare embeds the account id in the credential and needs it in the URL. */
  accountScoped?: boolean;
}

export const providerCatalog: ProviderDef[] = [
  { platform: 'google', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyless: false },
  { platform: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keyless: false },
  { platform: 'cerebras', name: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', keyless: false },
  { platform: 'sambanova', name: 'SambaNova', baseUrl: 'https://api.sambanova.ai/v1', keyless: false },
  { platform: 'nvidia', name: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1', keyless: false },
  { platform: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', keyless: false },
  {
    platform: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyless: false,
    headers: { 'HTTP-Referer': 'https://github.com/codingagent', 'X-Title': 'CodingAgent' },
  },
  { platform: 'github', name: 'GitHub Models', baseUrl: 'https://models.github.ai/inference', keyless: false },
  { platform: 'cohere', name: 'Cohere', baseUrl: 'https://api.cohere.ai/compatibility/v1', keyless: false },
  { platform: 'cloudflare', name: 'Cloudflare Workers AI', baseUrl: 'https://api.cloudflare.com/client/v4/accounts', keyless: false, accountScoped: true },
  { platform: 'zhipu', name: 'Zhipu AI', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyless: false },
  { platform: 'ollama', name: 'Ollama Cloud', baseUrl: 'https://ollama.com/v1', keyless: false, timeoutMs: 120000 },
  { platform: 'kilo', name: 'Kilo Gateway', baseUrl: 'https://api.kilo.ai/api/gateway/v1', keyless: true },
  { platform: 'pollinations', name: 'Pollinations', baseUrl: 'https://text.pollinations.ai/openai/v1', keyless: true },
  { platform: 'llm7', name: 'LLM7', baseUrl: 'https://api.llm7.io/v1', keyless: true },
  { platform: 'huggingface', name: 'HuggingFace Router', baseUrl: 'https://router.huggingface.co/v1', keyless: false },
  { platform: 'opencode', name: 'OpenCode Zen', baseUrl: 'https://opencode.ai/zen/v1', keyless: false },
  { platform: 'custom', name: 'Custom (OpenAI-compatible)', baseUrl: '', keyless: false, timeoutMs: 120000 },
];

const byPlatform = new Map<Platform, ProviderDef>(providerCatalog.map(p => [p.platform, p]));

export function providerByPlatform(platform: Platform): ProviderDef | undefined {
  return byPlatform.get(platform);
}

/** Cloudflare stores "account_id:api_token"; split out both parts. */
export function resolveEndpoint(
  platform: Platform,
  apiKey: string,
  baseUrlOverride?: string | null,
): { baseUrl: string; apiKey: string; headers: Record<string, string> } {
  const def = providerByPlatform(platform);
  if (!def) throw new Error(`Unknown provider platform: ${platform}`);

  if (platform === 'custom') {
    const trimmed = (baseUrlOverride || '').trim().replace(/\/+$/, '');
    if (!trimmed) throw new Error('Custom provider needs a base URL (set it on the API key row).');
    return { baseUrl: trimmed, apiKey, headers: {} };
  }
  if (def.accountScoped) {
    const sep = apiKey.indexOf(':');
    if (sep === -1) throw new Error('Cloudflare key must be "account_id:api_token".');
    return {
      baseUrl: `${def.baseUrl}/${apiKey.slice(0, sep)}/ai/v1`,
      apiKey: apiKey.slice(sep + 1),
      headers: {},
    };
  }
  return { baseUrl: def.baseUrl, apiKey, headers: def.headers ?? {} };
}

export function providerInfo(def: ProviderDef, configured: boolean, modelCount: number): ProviderInfo {
  return { platform: def.platform, name: def.name, baseUrl: def.baseUrl, keyless: def.keyless, configured, modelCount };
}
