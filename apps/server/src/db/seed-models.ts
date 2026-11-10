/**
 * First-run model catalog.
 *
 * A database inherited from FreeLLMAPI already carries ~100 models. A fresh
 * clone does not, and an empty `models` table leaves the model picker blank -
 * the app would boot "successfully" but no chat turn could ever run.
 *
 * So when (and only when) `models` is empty we seed a small, curated catalog:
 * the three most capable tool-calling models per platform. Ids mirror the
 * upstream catalog; add your own rows (or re-run the inherited snapshot) and
 * these seeds are simply skipped.
 */
import type Database from 'better-sqlite3';
import type { Platform } from '@codingagent/shared';

/** [platform, model_id, display_name, intelligence_rank, speed_rank, context_window, supports_vision] */
type SeedModel = [Platform, string, string, number, number, number, 0 | 1];

const DEFAULT_MODEL_CATALOG: SeedModel[] = [
  ['cerebras', 'gpt-oss-120b', 'GPT-OSS 120B (Cerebras)', 6, 1, 131072, 0],
  ['cerebras', 'zai-glm-4.7', 'GLM-4.7 (Cerebras)', 7, 1, 8192, 0],
  ['cloudflare', '@cf/moonshotai/kimi-k2.6', 'Kimi K2.6 (CF)', 2, 11, 262144, 0],
  ['cloudflare', '@cf/openai/gpt-oss-120b', 'GPT-OSS 120B (CF)', 6, 11, 131072, 0],
  ['cloudflare', '@cf/qwen/qwen3-30b-a3b-fp8', 'Qwen3 30B-A3B fp8 (CF)', 7, 11, 131072, 0],
  ['cohere', 'command-a-reasoning-08-2025', 'Command A Reasoning (08-2025)', 13, 11, 256000, 0],
  ['cohere', 'command-r-08-2024', 'Command R (08-2024)', 25, 11, 131072, 0],
  ['cohere', 'command-a-03-2025', 'Command-A (03-2025)', 27, 11, 131072, 0],
  ['github', 'openai/gpt-4.1', 'GPT-4.1 (GitHub)', 20, 7, 128000, 1],
  ['github', 'gpt-4o', 'GPT-4o', 25, 7, 8000, 1],
  ['google', 'gemini-3.5-flash', 'Gemini 3.5 Flash', 3, 5, 1048576, 1],
  ['google', 'gemini-3-flash-preview', 'Gemini 3 Flash Preview', 11, 5, 1048576, 1],
  ['google', 'gemini-3.1-flash-lite-preview', 'Gemini 3.1 Flash-Lite Preview', 18, 3, 1048576, 1],
  ['groq', 'openai/gpt-oss-120b', 'GPT-OSS 120B (Groq)', 6, 2, 131072, 0],
  ['groq', 'meta-llama/llama-4-scout-17b-16e-instruct', 'Llama 4 Scout', 12, 2, 131072, 1],
  ['groq', 'llama-3.3-70b-versatile', 'Llama 3.3 70B', 17, 2, 131072, 0],
  ['huggingface', 'Qwen/Qwen3-Coder-Next', 'Qwen3-Coder Next (HF)', 3, 9, 262144, 0],
  ['huggingface', 'moonshotai/Kimi-K2.6', 'Kimi K2.6 (HF)', 3, 9, 262144, 0],
  ['huggingface', 'deepseek-ai/DeepSeek-V4-Flash', 'DeepSeek V4 Flash (HF)', 4, 9, 131072, 0],
  ['kilo', 'nvidia/nemotron-3-super-120b-a12b:free', 'Nemotron 3 Super 120B (Kilo)', 22, 9, 262144, 0],
  ['llm7', 'codestral-latest', 'Codestral (LLM7)', 16, 8, 32000, 0],
  ['mistral', 'mistral-large-latest', 'Mistral Large 3', 14, 8, 262144, 0],
  ['mistral', 'mistral-medium-latest', 'Mistral Medium 3.5', 14, 8, 131072, 0],
  ['mistral', 'mistral-small-latest', 'Mistral Small 4', 14, 8, 262144, 0],
  ['nvidia', 'qwen/qwen3-coder-480b-a35b-instruct', 'Qwen3-Coder 480B (NV)', 2, 9, 262144, 0],
  ['nvidia', 'deepseek-ai/deepseek-v4-pro', 'DeepSeek V4 Pro (NV)', 3, 9, 131072, 0],
  ['nvidia', 'minimaxai/minimax-m2.7', 'MiniMax M2.7 (NV)', 3, 9, 196608, 0],
  ['ollama', 'qwen3-coder:480b', 'Qwen3-Coder 480B (Ollama)', 2, 9, 262144, 0],
  ['ollama', 'qwen3-coder-next', 'Qwen3-Coder Next (Ollama)', 3, 9, 262144, 0],
  ['ollama', 'glm-4.7', 'GLM-4.7 (Ollama)', 6, 9, 131072, 0],
  ['opencode', 'deepseek-v4-flash-free', 'DeepSeek V4 Flash Free (OpenCode Zen)', 4, 4, 131072, 0],
  ['opencode', 'nemotron-3-super-free', 'Nemotron 3 Super Free (OpenCode Zen)', 12, 4, 131072, 0],
  ['openrouter', 'qwen/qwen3-coder:free', 'Qwen3 Coder (free)', 2, 9, 1048576, 0],
  ['openrouter', 'qwen/qwen3-next-80b-a3b-instruct:free', 'Qwen3-Next 80B (free)', 3, 9, 262144, 0],
  ['openrouter', 'openai/gpt-oss-120b:free', 'GPT-OSS 120B (free)', 6, 9, 131072, 0],
  ['sambanova', 'DeepSeek-V3.2', 'DeepSeek V3.2', 4, 9, 32768, 0],
  ['sambanova', 'DeepSeek-V3.1', 'DeepSeek V3.1', 5, 9, 131072, 0],
  ['sambanova', 'gpt-oss-120b', 'GPT-OSS 120B (SambaNova)', 6, 9, 131072, 0],
  ['zhipu', 'glm-4.7-flash', 'GLM-4.7 Flash', 18, 4, 131072, 0],
  ['zhipu', 'glm-4.5-flash', 'GLM-4.5 Flash', 24, 4, 131072, 0],
];

/** How many seeded models get a fallback slot, so retries work out of the box. */
const FALLBACK_SLOTS = 5;

/**
 * Seeds the model catalog + fallback chain into an empty database. No-op when
 * the database already has models (inherited snapshot, or a user-curated list).
 * Returns the number of rows inserted.
 */
export function seedModelCatalog(db: Database.Database): number {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM models').get() as { n: number };
  if (existing.n > 0) return 0;

  const insertModel = db.prepare(`
    INSERT OR IGNORE INTO models
      (platform, model_id, display_name, intelligence_rank, speed_rank,
       size_label, context_window, enabled, supports_vision, supports_tools)
    VALUES (?,?,?,?,?, '', ?, 1, ?, 1)
  `);
  const insertFallback = db.prepare(
    'INSERT OR IGNORE INTO fallback_config (model_db_id, priority, enabled) VALUES (?,?,1)',
  );

  let inserted = 0;
  db.transaction(() => {
    for (const [platform, modelId, name, rank, speed, ctx, vision] of DEFAULT_MODEL_CATALOG) {
      inserted += insertModel.run(platform, modelId, name, rank, speed, ctx, vision).changes;
    }
    const best = db.prepare(`
      SELECT id FROM models WHERE enabled=1 AND supports_tools=1
      ORDER BY intelligence_rank ASC, speed_rank ASC LIMIT ?
    `).all(FALLBACK_SLOTS) as { id: number }[];
    best.forEach((row, i) => insertFallback.run(row.id, i + 1));
  })();

  return inserted;
}
