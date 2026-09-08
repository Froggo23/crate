import {
  ParsedQuery, ParsedQuerySchema, PARSED_QUERY_JSON_SCHEMA, PARSER_SYSTEM,
  MODE_NAMES, PITCH_NAMES,
} from './schema';
import { completeJson, providerConfigured } from './index';

export const EMPTY_QUERY: ParsedQuery = {
  bpm_min: null, bpm_max: null, tonics: null, modes: null, instrumental: null,
  year_min: null, year_max: null, emergence_max: null,
  energy_min: null, energy_max: null, brightness_min: null, brightness_max: null,
  duration_min: null, duration_max: null, tags: null, keywords: null,
  semantic: '', min_mode_confidence: null, limit: 20, reasoning: '',
};

/**
 * Deterministic parser.
 *
 * Two jobs. It keeps the app usable with no LLM key configured, and it is the
 * "keyword search over tags" control condition from the plan's section 5 — the
 * baseline the LLM parser has to beat in evaluation. Keeping it in the shipped
 * code path rather than in a notebook means it is always runnable and always
 * honest about what it does.
 */
export function fallbackParse(text: string): ParsedQuery {
  const q: ParsedQuery = { ...EMPTY_QUERY, semantic: text, reasoning: 'Parsed by rule-based fallback (no LLM).' };
  const lower = text.toLowerCase();

  const range = lower.match(/(?:between\s+)?(\d{2,3})\s*(?:-|–|to|and)\s*(\d{2,3})\s*(?:bpm)?/);
  const around = lower.match(/(?:around|about|~|circa|roughly)\s*(\d{2,3})\s*bpm/);
  const exact = lower.match(/(\d{2,3})\s*bpm/);
  if (range) { q.bpm_min = +range[1]; q.bpm_max = +range[2]; }
  else if (around) { q.bpm_min = +around[1] - 8; q.bpm_max = +around[1] + 8; }
  else if (exact) { q.bpm_min = +exact[1] - 4; q.bpm_max = +exact[1] + 4; }

  const modes = MODE_NAMES.filter((m) => lower.includes(m.replace('_', ' ')) || lower.includes(m));
  if (modes.length) { q.modes = modes; q.min_mode_confidence = 0.5; }
  else if (/\bminor\b/.test(lower)) q.modes = ['aeolian', 'dorian', 'phrygian'];
  else if (/\bmajor\b/.test(lower)) q.modes = ['ionian', 'lydian', 'mixolydian'];

  const key = text.match(/\b(?:in\s+)([A-G](?:#|b)?)\b(?=\s|$|,)/);
  if (key) {
    const n = key[1].replace('b', '#');
    const idx = PITCH_NAMES.indexOf(n as (typeof PITCH_NAMES)[number]);
    if (idx >= 0) q.tonics = [PITCH_NAMES[idx]];
  }

  if (/\b(no vocals?|instrumental|without vocals?)\b/.test(lower)) q.instrumental = true;
  else if (/\b(vocals?|sung|singing|vocal)\b/.test(lower)) q.instrumental = false;

  if (/\b(emerging|unknown|underground|obscure|undiscovered|no big names)\b/.test(lower)) q.emergence_max = 20;

  if (/\b(high energy|energetic|driving|intense|banging|hard)\b/.test(lower)) q.energy_min = 0.6;
  if (/\b(calm|ambient|gentle|quiet|sparse|still|slow)\b/.test(lower)) q.energy_max = 0.45;
  if (/\b(bright|crisp|airy|shimmering)\b/.test(lower)) q.brightness_min = 0.6;
  if (/\b(dark|muffled|murky|dull|warm)\b/.test(lower)) q.brightness_max = 0.45;

  const count = lower.match(/\b(?:give me|show|top)?\s*(\d{1,2})\s*(?:results|tracks|songs)\b/);
  if (count) q.limit = Math.min(50, Math.max(1, Number(count[1])));

  const years = lower.match(/\b(19|20)\d{2}\b/g);
  if (years?.length === 1) { q.year_min = +years[0]; q.year_max = +years[0]; }
  else if (years && years.length >= 2) {
    const ns = years.map(Number).sort((a, b) => a - b);
    q.year_min = ns[0]; q.year_max = ns[ns.length - 1];
  }
  return q;
}

function sanitise(q: ParsedQuery): ParsedQuery {
  const clampNum = (v: number | null, lo: number, hi: number) =>
    v == null ? null : Math.min(hi, Math.max(lo, v));
  const out: ParsedQuery = {
    ...q,
    bpm_min: clampNum(q.bpm_min, 20, 300),
    bpm_max: clampNum(q.bpm_max, 20, 300),
    emergence_max: clampNum(q.emergence_max, 0, 100),
    energy_min: clampNum(q.energy_min, 0, 1),
    energy_max: clampNum(q.energy_max, 0, 1),
    brightness_min: clampNum(q.brightness_min, 0, 1),
    brightness_max: clampNum(q.brightness_max, 0, 1),
    min_mode_confidence: clampNum(q.min_mode_confidence, 0, 1),
    duration_min: clampNum(q.duration_min, 0, 3600),
    duration_max: clampNum(q.duration_max, 0, 3600),
    limit: Math.min(50, Math.max(1, q.limit || 20)),
    tags: q.tags?.map((t) => t.toLowerCase().trim()).filter(Boolean).slice(0, 8) ?? null,
    modes: q.modes?.filter((m) => (MODE_NAMES as readonly string[]).includes(m)) ?? null,
  };
  // a model that emits min > max would otherwise silently return nothing
  if (out.bpm_min != null && out.bpm_max != null && out.bpm_min > out.bpm_max) {
    [out.bpm_min, out.bpm_max] = [out.bpm_max, out.bpm_min];
  }
  if (out.modes && out.modes.length === 0) out.modes = null;
  if (out.tags && out.tags.length === 0) out.tags = null;
  // An empty semantic string means no vector ordering at all, which silently
  // degrades the query to a plain SQL filter. Fall back to the user's own words.
  if (!out.semantic?.trim()) out.semantic = '';
  return out;
}

export interface ParseOutcome {
  query: ParsedQuery;
  provider: string;
  model: string;
  ms: number;
  usedFallback: boolean;
}

export async function parseQuery(text: string): Promise<ParseOutcome> {
  if (!providerConfigured()) {
    const t0 = Date.now();
    return { query: sanitise(fallbackParse(text)), provider: 'rule-based', model: 'fallback', ms: Date.now() - t0, usedFallback: true };
  }
  try {
    const r = await completeJson({
      system: PARSER_SYSTEM,
      user: `Query: ${text}`,
      schemaName: 'crate_query',
      jsonSchema: PARSED_QUERY_JSON_SCHEMA,
      validator: ParsedQuerySchema,
      maxTokens: 2000,
      // Must leave room inside the 60s function budget for embedding, SQL and
      // the re-ranker. If the parser is slow, the rule-based fallback is a far
      // better outcome than a 504.
      timeoutMs: 15_000,
      retries: 1,
    });
    const q = sanitise(r.data);
    // An empty semantic string means no vector ordering at all, which silently
    // degrades the query to a bare SQL filter. Fall back to the user's own words.
    if (!q.semantic.trim()) q.semantic = text;
    return { query: q, provider: r.provider, model: r.model, ms: r.ms, usedFallback: false };
  } catch (e) {
    // a parser outage should degrade the results, not take the search box down
    console.error('[parse] LLM parse failed, falling back:', (e as Error).message);
    return {
      query: sanitise({ ...fallbackParse(text), reasoning: `LLM parse failed (${(e as Error).message.slice(0, 120)}); used rule-based fallback.` }),
      provider: 'rule-based', model: 'fallback', ms: 0, usedFallback: true,
    };
  }
}
