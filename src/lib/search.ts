/**
 * Retrieval orchestration: parse -> filter -> vector -> re-rank -> log.
 *
 * The ordering here is the whole point of the system (plan section 3, [2]).
 * Hard constraints are applied inside `crate_search` BEFORE any similarity is
 * computed, so a "no vocals" query can never surface a vocal track no matter how
 * well it matches the vibe. The LLM only ever reorders survivors; it is never
 * given the chance to override a constraint.
 */

import { db, toVector } from './db';
import { embedOne } from './embed';
import { parseQuery } from './llm/parse';
import { rerank } from './llm/rerank';
import { PITCH_NAMES } from './llm/schema';
import type { ParsedQuery } from './llm/schema';

export interface SearchRow {
  track_id: string;
  title: string;
  artist_id: string;
  artist_name: string;
  album: string | null;
  year: number | null;
  duration_sec: number | null;
  audio_url: string;
  page_url: string | null;
  license_short: string | null;
  license_url: string | null;
  artwork_url: string | null;
  tags: string[] | null;
  bpm: number | null;
  bpm_confidence: number | null;
  tonic: number | null;
  mode: string | null;
  mode_confidence: number | null;
  key_name: string | null;
  baseline_key_name: string | null;
  mode_scores: Record<string, unknown> | null;
  hpcp: number[] | null;
  energy: number | null;
  brightness: number | null;
  instrumental_likelihood: number | null;
  loudness_db: number | null;
  spectral_centroid: number | null;
  spectral_flatness: number | null;
  percussive_ratio: number | null;
  emergence_percentile: number | null;
  listenbrainz_listens: number | null;
  distance: number | null;
  tag_overlap: number | null;
  reason?: string | null;
  preRerankRank?: number;
  /** true when this track only appears because a constraint was relaxed */
  relaxed?: boolean;
}

export interface FunnelDiagnostics {
  corpus: number;
  alone: Record<string, number>;
  cumulative: Record<string, number>;
  active: Record<string, boolean>;
  /** the first active constraint whose addition emptied the set */
  culprit: string | null;
  message: string;
}

export interface Relaxation {
  /** human-readable description of what was loosened */
  note: string;
  /** how many results existed before this step */
  before: number;
  /** how many after */
  after: number;
}

export interface SearchResponse {
  diagnostics: FunnelDiagnostics | null;
  /** constraints that had to be loosened to find anything, in the order applied */
  relaxations: Relaxation[];
  strictCount: number;
  queryId: string | null;
  raw: string;
  parsed: ParsedQuery;
  results: SearchRow[];
  summary: string | null;
  candidateCount: number;
  meta: {
    parseProvider: string;
    parseModel: string;
    parseMs: number;
    usedFallback: boolean;
    embedMs: number;
    retrieveMs: number;
    rerankProvider: string;
    rerankModel: string;
    rerankMs: number;
    reranked: boolean;
  };
}

/** Over-fetch, then let the re-ranker cut. Plan section 3 says top 50. */
const CANDIDATE_POOL = 50;

/** Below this, a query is treated as having effectively failed and constraints
 *  are progressively relaxed rather than handing back an empty page. */
const MIN_RESULTS = 5;

/** Order matters: it is the order the funnel narrows in, and therefore the order
 *  in which blame is assigned. Cheapest and most commonly over-tight first. */
const FUNNEL_ORDER = [
  'tempo', 'key', 'mode', 'vocals', 'energy', 'brightness',
  'year', 'duration', 'tags', 'text', 'obscurity',
] as const;

// `tags` is retained in the funnel's vocabulary but is never active any more,
// since style tags rank rather than filter. Leaving the key in keeps the SQL
// signature stable.
const FUNNEL_LABEL: Record<string, string> = {
  tempo: 'the tempo range', key: 'the key', mode: 'the mode',
  vocals: 'the vocals/instrumental requirement', energy: 'the energy range',
  brightness: 'the brightness range', year: 'the year range',
  duration: 'the duration range', tags: 'the genre tags',
  text: 'the artist/title text', obscurity: 'the obscurity ceiling',
};

async function explainFunnel(q: ParsedQuery): Promise<FunnelDiagnostics | null> {
  const sql = db();
  try {
    const r = await sql`
      select crate_constraint_funnel(
        p_bpm_min        => ${q.bpm_min},
        p_bpm_max        => ${q.bpm_max},
        p_tonics         => ${tonicsToPitchClasses(q.tonics)}::int[],
        p_modes          => ${q.modes}::text[],
        p_year_min       => ${q.year_min},
        p_year_max       => ${q.year_max},
        p_instrumental   => ${q.instrumental},
        p_emergence_max  => ${q.emergence_max},
        p_energy_min     => ${q.energy_min},
        p_energy_max     => ${q.energy_max},
        p_brightness_min => ${q.brightness_min},
        p_brightness_max => ${q.brightness_max},
        p_duration_min   => ${q.duration_min},
        p_duration_max   => ${q.duration_max},
        p_tags_any       => ${null}::text[],
        p_text           => ${q.keywords},
        p_min_mode_conf  => ${q.min_mode_confidence}
      ) as f`;
    const f = r[0].f as Omit<FunnelDiagnostics, 'culprit' | 'message'>;

    let prev = f.corpus;
    let culprit: string | null = null;
    for (const step of FUNNEL_ORDER) {
      const n = f.cumulative[step] ?? prev;
      if (f.active[step] && n === 0 && prev > 0) { culprit = step; break; }
      prev = n;
    }

    const message = culprit
      ? `No track satisfies every constraint. ${prev} track${prev === 1 ? '' : 's'} matched everything up to ` +
        `${FUNNEL_LABEL[culprit]}, and none survived it — on its own, ${FUNNEL_LABEL[culprit]} matches ` +
        `${f.alone[culprit] ?? 0} of ${f.corpus}. Relax that one first.`
      : `No track satisfies every constraint, and no single constraint is solely responsible — ` +
        `the combination is simply not present in the ${f.corpus} tracks indexed so far.`;

    return { ...f, culprit, message };
  } catch (e) {
    console.error('[search] funnel failed (non-fatal):', (e as Error).message);
    return null;
  }
}

function tonicsToPitchClasses(tonics: string[] | null): number[] | null {
  if (!tonics?.length) return null;
  const out = tonics
    .map((t) => PITCH_NAMES.indexOf(t as (typeof PITCH_NAMES)[number]))
    .filter((i) => i >= 0);
  return out.length ? out : null;
}

export async function runSearch(
  rawText: string,
  sessionId: string,
  opts: { log?: boolean; skipRerank?: boolean } = {},
): Promise<SearchResponse> {
  const sql = db();
  const parse = await parseQuery(rawText);
  const q = parse.query;

  // ---- embed the semantic half -------------------------------------------
  const tEmbed = Date.now();
  let qVec: string | null = null;
  const semantic = (q.semantic || '').trim();
  if (semantic) {
    try {
      qVec = toVector(await embedOne(semantic));
    } catch (e) {
      console.error('[search] embedding failed, falling back to filter-only:', (e as Error).message);
    }
  }
  const embedMs = Date.now() - tEmbed;

  // ---- filter first, then rank -------------------------------------------
  const tRetrieve = Date.now();
  const pool = Math.max(CANDIDATE_POOL, q.limit);

  const runQuery = async (qq: ParsedQuery): Promise<SearchRow[]> => (await sql`
    select * from crate_search(
      q_vec            => ${qVec}::vector(1536),
      p_bpm_min        => ${qq.bpm_min},
      p_bpm_max        => ${qq.bpm_max},
      p_tonics         => ${tonicsToPitchClasses(qq.tonics)}::int[],
      p_modes          => ${qq.modes}::text[],
      p_year_min       => ${qq.year_min},
      p_year_max       => ${qq.year_max},
      p_instrumental   => ${qq.instrumental},
      p_emergence_max  => ${qq.emergence_max},
      p_energy_min     => ${qq.energy_min},
      p_energy_max     => ${qq.energy_max},
      p_brightness_min => ${qq.brightness_min},
      p_brightness_max => ${qq.brightness_max},
      p_duration_min   => ${qq.duration_min},
      p_duration_max   => ${qq.duration_max},
      p_text           => ${qq.keywords},
      p_min_mode_conf  => ${qq.min_mode_confidence},
      p_tags_boost     => ${qq.tags}::text[],
      p_limit          => ${pool}
    )`) as unknown as SearchRow[];

  let rows = await runQuery(q);
  const strictCount = rows.length;
  const relaxations: Relaxation[] = [];

  // ---- progressive relaxation --------------------------------------------
  //
  // A single over-tight constraint should degrade the answer, not erase it.
  // Measured before this existed: 20% of arbitrary queries returned nothing and
  // many more returned one or two rows, because the parser had inferred a
  // brightness ceiling or a mode-confidence floor from an adjective.
  //
  // Constraints are relaxed in order of how likely they are to have been INFERRED
  // rather than stated. A mode-confidence floor is always the parser's own
  // invention; a named key or "no vocals" is the user's. The last two are never
  // touched: the plan is explicit that a vocal track must never appear in a
  // "no vocals" query no matter how well it matches, and the same holds for a
  // named mode -- those are the system's actual claims about the music.
  //
  // Whatever gets loosened is reported back and shown in the UI. Silently
  // widening a constraint would be worse than returning nothing.
  if (rows.length < MIN_RESULTS) {
    const widenBpm = (x: ParsedQuery, by: number): ParsedQuery => ({
      ...x,
      bpm_min: x.bpm_min == null ? null : Math.max(20, x.bpm_min * (1 - by)),
      bpm_max: x.bpm_max == null ? null : Math.min(300, x.bpm_max * (1 + by)),
    });

    const TIERS: { note: string; applies: (x: ParsedQuery) => boolean; mutate: (x: ParsedQuery) => ParsedQuery }[] = [
      { note: 'the mode-confidence floor',
        applies: (x) => x.min_mode_confidence != null,
        mutate: (x) => ({ ...x, min_mode_confidence: null }) },
      { note: 'the energy and brightness ranges',
        applies: (x) => [x.energy_min, x.energy_max, x.brightness_min, x.brightness_max].some((v) => v != null),
        mutate: (x) => ({ ...x, energy_min: null, energy_max: null, brightness_min: null, brightness_max: null }) },
      { note: 'the tempo range, widened by 25%',
        applies: (x) => x.bpm_min != null || x.bpm_max != null,
        mutate: (x) => widenBpm(x, 0.25) },
      { note: 'the duration and year limits',
        applies: (x) => [x.duration_min, x.duration_max, x.year_min, x.year_max].some((v) => v != null),
        mutate: (x) => ({ ...x, duration_min: null, duration_max: null, year_min: null, year_max: null }) },
      { note: 'the artist/title text match',
        applies: (x) => Boolean(x.keywords),
        mutate: (x) => ({ ...x, keywords: null }) },
      { note: 'the obscurity ceiling',
        applies: (x) => x.emergence_max != null,
        mutate: (x) => ({ ...x, emergence_max: null }) },
      { note: 'the tempo range entirely',
        applies: (x) => x.bpm_min != null || x.bpm_max != null,
        mutate: (x) => ({ ...x, bpm_min: null, bpm_max: null }) },
      { note: 'the requested key',
        applies: (x) => Boolean(x.tonics?.length),
        mutate: (x) => ({ ...x, tonics: null }) },
    ];

    let current = q;
    const seen = new Set(rows.map((r) => r.track_id));
    for (const tier of TIERS) {
      if (rows.length >= MIN_RESULTS) break;
      if (!tier.applies(current)) continue;
      const before = rows.length;
      current = tier.mutate(current);
      const next = await runQuery(current);
      // strict matches keep their position; relaxed ones are appended and flagged
      for (const r of next) {
        if (seen.has(r.track_id)) continue;
        seen.add(r.track_id);
        r.relaxed = true;
        rows.push(r);
      }
      if (rows.length !== before) relaxations.push({ note: tier.note, before, after: rows.length });
    }
  }
  const retrieveMs = Date.now() - tRetrieve;

  rows.forEach((r, i) => { r.preRerankRank = i + 1; });

  // ---- re-rank and explain -----------------------------------------------
  let ordered = rows.slice(0, q.limit);
  let summary: string | null = null;
  let rr = { result: null as Awaited<ReturnType<typeof rerank>>['result'], provider: 'none', model: 'none', ms: 0 };

  if (!opts.skipRerank && rows.length) {
    rr = await rerank(rawText, q.reasoning, rows);
    if (rr.result?.ranked?.length) {
      const byId = new Map(rows.map((r) => [r.track_id, r]));
      const picked: SearchRow[] = [];
      for (const item of rr.result.ranked) {
        const row = byId.get(item.id);
        if (row && !picked.includes(row)) { row.reason = item.reason; picked.push(row); }
      }
      // anything the re-ranker dropped stays available behind the ones it kept
      for (const r of rows) if (!picked.includes(r)) picked.push(r);
      ordered = picked.slice(0, q.limit);
      summary = rr.result.summary;
    }
  }

  // ---- log: this is the accumulating relevance dataset (section 2.3) ------
  let queryId: string | null = null;
  if (opts.log !== false) {
    try {
      const ins = await sql`
        insert into queries (session_id, raw_text, parsed, parse_ms, retrieve_ms, rerank_ms,
                             provider, model, candidate_count, result_count)
        values (${sessionId}, ${rawText}, ${sql.json(q as never)}, ${parse.ms}, ${retrieveMs}, ${rr.ms},
                ${parse.provider}, ${parse.model}, ${rows.length}, ${ordered.length})
        returning id`;
      queryId = ins[0].id as string;
      if (ordered.length) {
        await sql`
          insert into query_results ${sql(
            ordered.map((r, i) => ({
              query_id: queryId,
              track_id: r.track_id,
              rank: i + 1,
              pre_rerank_rank: r.preRerankRank ?? null,
              vector_distance: r.distance,
              reason: r.reason ?? null,
            })),
            'query_id', 'track_id', 'rank', 'pre_rerank_rank', 'vector_distance', 'reason',
          )}`;
      }
    } catch (e) {
      console.error('[search] logging failed (non-fatal):', (e as Error).message);
    }
  }

  // "0 results" on its own is useless. Filter-first retrieval means we can point
  // at the exact predicate that emptied the set, so do that.
  const diagnostics = rows.length === 0 ? await explainFunnel(q) : null;

  return {
    diagnostics,
    relaxations,
    strictCount,
    queryId,
    raw: rawText,
    parsed: q,
    results: ordered,
    summary,
    candidateCount: rows.length,
    meta: {
      parseProvider: parse.provider,
      parseModel: parse.model,
      parseMs: parse.ms,
      usedFallback: parse.usedFallback,
      embedMs,
      retrieveMs,
      rerankProvider: rr.provider,
      rerankModel: rr.model,
      rerankMs: rr.ms,
      reranked: Boolean(rr.result),
    },
  };
}
