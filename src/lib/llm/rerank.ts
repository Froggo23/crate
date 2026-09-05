import { RerankSchema, RERANK_JSON_SCHEMA, RERANK_SYSTEM, RerankResult } from './schema';
import { completeJson, providerConfigured } from './index';
import type { SearchRow } from '../search';

/** Compact feature profile handed to the re-ranker. Keep it dense: this is the
 *  only thing the model knows about each track. */
export function candidateLine(r: SearchRow, i: number): string {
  const mode = r.mode === 'unclear'
    ? 'mode unclear'
    : `${r.key_name} (confidence ${(r.mode_confidence ?? 0).toFixed(2)})`;
  return [
    `[${r.track_id}] #${i + 1} "${r.title}" — ${r.artist_name}${r.year ? ` (${r.year})` : ''}`,
    `  ${(r.bpm ?? 0).toFixed(0)} BPM · ${mode} · energy ${(r.energy ?? 0).toFixed(2)} · brightness ${(r.brightness ?? 0).toFixed(2)}`,
    `  instrumental-likelihood ${(r.instrumental_likelihood ?? 0).toFixed(2)} · percussive ${(r.percussive_ratio ?? 0).toFixed(2)}` +
    ` · centroid ${(r.spectral_centroid ?? 0).toFixed(0)}Hz · loudness ${(r.loudness_db ?? 0).toFixed(1)}dB` +
    ` · artist popularity pct ${r.emergence_percentile == null ? 'n/a' : r.emergence_percentile.toFixed(0)}`,
    r.tags?.length ? `  tags: ${r.tags.slice(0, 8).join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

export interface RerankOutcome {
  result: RerankResult | null;
  provider: string;
  model: string;
  ms: number;
}

export async function rerank(
  rawQuery: string,
  parsedReasoning: string,
  candidates: SearchRow[],
): Promise<RerankOutcome> {
  if (!providerConfigured() || candidates.length === 0) {
    return { result: null, provider: 'none', model: 'none', ms: 0 };
  }
  const user = [
    `User query: ${rawQuery}`,
    parsedReasoning ? `How it was parsed: ${parsedReasoning}` : '',
    '',
    `${candidates.length} candidates, already filtered to satisfy every hard constraint:`,
    '',
    candidates.map(candidateLine).join('\n\n'),
  ].filter(Boolean).join('\n');

  try {
    const r = await completeJson({
      system: RERANK_SYSTEM,
      user,
      schemaName: 'crate_rerank',
      jsonSchema: RERANK_JSON_SCHEMA,
      validator: RerankSchema,
      maxTokens: 8000,
    });
    return { result: r.data, provider: r.provider, model: r.model, ms: r.ms };
  } catch (e) {
    console.error('[rerank] failed, keeping vector order:', (e as Error).message);
    return { result: null, provider: 'none', model: 'none', ms: 0 };
  }
}
