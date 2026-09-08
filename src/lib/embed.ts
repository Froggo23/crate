/** OpenAI text embeddings, batched, at the dimensionality the schema expects. */

import { fetchWithRetry } from './net';

export const EMBED_DIM = 1536;

export function embedModel(): string {
  return process.env.OPENAI_EMBED_MODEL ?? 'text-embedding-3-small';
}

interface EmbeddingResponse {
  data: { index: number; embedding: number[] }[];
  usage?: { total_tokens: number };
}

export interface EmbedOptions {
  /** per-request timeout. Interactive paths must fit inside the function budget. */
  timeoutMs?: number;
  retries?: number;
}

export async function embedTexts(texts: string[], opt: EmbedOptions = {}): Promise<number[][]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set');
  if (!texts.length) return [];

  const out: number[][] = new Array(texts.length);
  const BATCH = 96;

  for (let i = 0; i < texts.length; i += BATCH) {
    const chunk = texts.slice(i, i + BATCH).map((t) => (t || ' ').slice(0, 8000));
    const res = await fetchWithRetry('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      timeoutMs: opt.timeoutMs ?? 60_000,
      retries: opt.retries,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: embedModel(), input: chunk }),
    });
    const json = (await res.json()) as EmbeddingResponse;
    for (const row of json.data) {
      if (row.embedding.length !== EMBED_DIM) {
        throw new Error(`expected ${EMBED_DIM}-dim embedding, got ${row.embedding.length}`);
      }
      out[i + row.index] = row.embedding;
    }
  }
  return out;
}

export async function embedOne(text: string, opt: EmbedOptions = {}): Promise<number[]> {
  return (await embedTexts([text], opt))[0];
}
