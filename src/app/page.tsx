'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ResultCard } from '@/components/ResultCard';
import type { SearchResponse } from '@/lib/search';

const EXAMPLES = [
  // A deliberate mix: the theory-heavy queries the engine was built for, and
  // plain-language ones, because those have to work just as well.
  'dub techno from emerging artists, around 100 BPM',
  'uptempo electronica in Phrygian, no vocals, high energy',
  'lo-fi hip hop',
  'hazy and cavernous, warm tape saturation, dark on top',
  'reggae dub',
  'something to fall asleep to',
  'slow Dorian something, sparse percussion, instrumental',
  'glitchy experimental noise',
  'driving minor techno between 128 and 136 BPM, no vocals',
  'music for studying',
];

function sessionId(): string {
  if (typeof window === 'undefined') return 'ssr';
  let s = localStorage.getItem('crate.session');
  if (!s) { s = crypto.randomUUID(); localStorage.setItem('crate.session', s); }
  return s;
}

/** The parsed query, rendered. This is deliberately not hidden behind a
 *  "debug" toggle: showing what the system decided your words meant is the
 *  difference between a search box you can steer and one you have to guess at. */
function ParsedView({ r }: { r: SearchResponse }) {
  const p = r.parsed;
  const hard: [string, string][] = [];
  const range = (lo: number | null, hi: number | null, unit = '') =>
    lo != null && hi != null ? `${lo}–${hi}${unit}` : lo != null ? `≥ ${lo}${unit}` : hi != null ? `≤ ${hi}${unit}` : null;

  const bpm = range(p.bpm_min, p.bpm_max);            if (bpm) hard.push(['tempo', `${bpm} BPM`]);
  if (p.tonics?.length) hard.push(['key', p.tonics.join(', ')]);
  if (p.modes?.length) hard.push(['mode', p.modes.map((m) => m.replace(/_/g, ' ')).join(' / ')]);
  if (p.min_mode_confidence != null) hard.push(['mode conf.', `≥ ${p.min_mode_confidence}`]);
  if (p.instrumental != null) hard.push(['vocals', p.instrumental ? 'instrumental only' : 'vocals required']);
  if (p.emergence_max != null) hard.push(['obscurity', `popularity pct ≤ ${p.emergence_max}`]);
  const en = range(p.energy_min, p.energy_max);       if (en) hard.push(['energy', en]);
  const br = range(p.brightness_min, p.brightness_max); if (br) hard.push(['brightness', br]);
  const yr = range(p.year_min, p.year_max);           if (yr) hard.push(['year', yr]);
  const du = range(p.duration_min, p.duration_max, 's'); if (du) hard.push(['duration', du]);
  if (p.tags?.length) hard.push(['tags', p.tags.join(', ')]);
  if (p.keywords) hard.push(['text', p.keywords]);

  return (
    <div className="card p-3.5 space-y-2.5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-[11px] uppercase tracking-[0.14em] text-mute">how this was read</h2>
        <span className="num text-[10px] text-mute">
          parse {r.meta.parseMs}ms · embed {r.meta.embedMs}ms · sql {r.meta.retrieveMs}ms
          {r.meta.reranked ? ` · rerank ${r.meta.rerankMs}ms` : ''}
        </span>
      </div>

      <div>
        <p className="text-[10px] uppercase tracking-wider text-mute mb-1.5">
          hard constraints — applied in SQL before any similarity is computed
        </p>
        {hard.length ? (
          <div className="flex flex-wrap gap-1.5">
            {hard.map(([k, v]) => (
              <span key={k} className="chip" style={{ color: 'var(--cyan)', borderColor: 'color-mix(in srgb, var(--cyan) 40%, var(--line-2))' }}>
                <span className="text-mute">{k}</span> {v}
              </span>
            ))}
          </div>
        ) : <p className="text-[12px] text-mute">none — this query is entirely semantic.</p>}
      </div>

      <div>
        <p className="text-[10px] uppercase tracking-wider text-mute mb-1">
          semantic intent — embedded and used only to reorder what survived
        </p>
        <p className="text-[12.5px] text-dim italic leading-relaxed">
          {p.semantic || <span className="text-mute not-italic">none</span>}
        </p>
      </div>

      {p.reasoning && <p className="text-[11.5px] text-mute leading-relaxed border-t border-line pt-2">{p.reasoning}</p>}

      <p className="text-[10px] text-mute">
        parser: {r.meta.parseProvider}/{r.meta.parseModel}
        {r.meta.usedFallback && <span style={{ color: 'var(--accent)' }}> · rule-based fallback (no LLM)</span>}
        {r.meta.reranked && ` · reranker: ${r.meta.rerankProvider}/${r.meta.rerankModel}`}
        {` · ${r.candidateCount} candidates passed the filter`}
      </p>
    </div>
  );
}

/** When constraints had to be loosened, say so. Silently widening a filter would
 *  be worse than returning nothing — the point of the system is that you can
 *  trust what it claims about the music. */
function RelaxNotice({ r }: { r: SearchResponse }) {
  if (!r.relaxations.length) return null;
  return (
    <div className="card p-3.5" style={{ borderColor: 'color-mix(in srgb, var(--accent) 32%, var(--line))' }}>
      <p className="text-[12.5px] text-dim leading-relaxed">
        <span style={{ color: 'var(--accent)' }}>
          {r.strictCount === 0
            ? 'Nothing matched every constraint exactly.'
            : `Only ${r.strictCount} track${r.strictCount === 1 ? '' : 's'} matched every constraint.`}
        </span>{' '}
        Loosened {r.relaxations.map((x) => x.note).join(', then ')} to find more. Results below the
        exact matches are marked. Mode, key and the vocals requirement are never relaxed.
      </p>
    </div>
  );
}

function Diagnostics({ d }: { d: NonNullable<SearchResponse['diagnostics']> }) {
  const steps = Object.keys(d.cumulative).filter((k) => d.active[k]);
  return (
    <div className="card p-4 space-y-3" style={{ borderColor: 'color-mix(in srgb, var(--accent) 35%, var(--line))' }}>
      <h2 className="text-[13px] font-medium" style={{ color: 'var(--accent)' }}>Nothing matched — here is where it collapsed</h2>
      <p className="text-[13px] text-dim leading-relaxed">{d.message}</p>
      {steps.length > 0 && (
        <div className="scroll-x">
          <table className="w-full text-[11.5px] min-w-[380px]">
            <thead>
              <tr className="text-mute text-[10px] uppercase tracking-wider">
                <th className="text-left font-normal pb-1">constraint</th>
                <th className="text-right font-normal pb-1">alone</th>
                <th className="text-right font-normal pb-1">cumulative</th>
              </tr>
            </thead>
            <tbody className="num">
              {steps.map((k) => (
                <tr key={k} className={d.culprit === k ? 'text-accent' : 'text-dim'}>
                  <td className="py-0.5">{k}{d.culprit === k ? '  ← relax this' : ''}</td>
                  <td className="text-right">{d.alone[k]}</td>
                  <td className="text-right">{d.cumulative[k]}</td>
                </tr>
              ))}
              <tr className="text-mute border-t border-line">
                <td className="pt-1">corpus</td>
                <td className="text-right pt-1">{d.corpus}</td>
                <td className="text-right pt-1">{d.corpus}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function SearchPage() {
  const [q, setQ] = useState('');
  const [data, setData] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [corpus, setCorpus] = useState<{ tracks_analyzed?: string; artists_total?: string; mode_decided_pct?: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch('/api/stats').then((r) => r.json()).then((d) => setCorpus(d.stats)).catch(() => {});
  }, []);

  const run = useCallback(async (text: string) => {
    const query = text.trim();
    if (!query || loading) return;
    setLoading(true); setError(null);
    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, sessionId: sessionId() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `search failed (${res.status})`);
      setData(json);
    } catch (e) {
      setError((e as Error).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [loading]);

  return (
    <div className="mx-auto max-w-3xl px-5 py-10">
      <section className="mb-7">
        <h1 className="text-[26px] sm:text-[30px] font-semibold tracking-tight leading-tight">
          Search music by what it <span className="text-accent">actually is</span>.
        </h1>
        <p className="mt-2 text-[14px] text-dim leading-relaxed max-w-2xl">
          Every track here was analysed by signal processing, not by tags or listening history — tempo,
          harmonic pitch class profile, and a modal key detector that can tell E&nbsp;Phrygian from C&nbsp;major.
          Ask for what you want in words.
        </p>
        {corpus?.tracks_analyzed && (
          <p className="mt-2 num text-[11px] text-mute">
            {corpus.tracks_analyzed} tracks analysed · {corpus.artists_total} artists ·
            mode assigned on {corpus.mode_decided_pct}% (the rest abstain rather than guess)
          </p>
        )}
      </section>

      <form onSubmit={(e) => { e.preventDefault(); void run(q); }} className="sticky top-14 z-30 bg-bg/90 backdrop-blur-md py-2 -mx-1 px-1">
        <div className="flex gap-2">
          <input
            ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="dub techno from emerging artists, around 100 BPM"
            aria-label="Search query"
            className="flex-1 min-w-0 card px-3.5 py-3 text-[14px] placeholder:text-mute focus:border-accent transition-colors"
          />
          <button type="submit" disabled={loading || !q.trim()}
                  className="px-5 rounded-xl text-[13px] font-medium transition-colors disabled:opacity-40 shrink-0"
                  style={{ background: 'var(--accent)', color: '#17130a' }}>
            {loading ? '…' : 'Search'}
          </button>
        </div>
      </form>

      {!data && !loading && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {EXAMPLES.map((ex) => (
            <button key={ex} onClick={() => { setQ(ex); void run(ex); }}
                    className="chip hover:border-accent hover:text-accent transition-colors text-left
                               !whitespace-normal !overflow-visible max-w-full"
                    style={{ color: 'var(--text-dim)' }}>
              {ex}
            </button>
          ))}
        </div>
      )}

      {loading && (
        <div className="mt-6 space-y-2">
          <p className="text-[12px] text-mute pulse">parsing → filtering → embedding → re-ranking…</p>
          {[0, 1, 2].map((i) => <div key={i} className="card h-20 pulse" style={{ animationDelay: `${i * 120}ms` }} />)}
        </div>
      )}

      {error && (
        <div className="mt-6 card p-4" style={{ borderColor: 'var(--red)' }}>
          <p className="text-[13px]" style={{ color: 'var(--red)' }}>{error}</p>
        </div>
      )}

      {data && !loading && (
        <div className="mt-5 space-y-4">
          <ParsedView r={data} />
          <RelaxNotice r={data} />
          {data.summary && (
            <p className="text-[13px] text-dim leading-relaxed px-1">{data.summary}</p>
          )}
          {data.results.length > 0 ? (
            <div className="space-y-2.5">
              {data.results.map((row, i) => (
                <ResultCard key={row.track_id} row={row} index={i} queryId={data.queryId} sessionId={sessionId()} />
              ))}
            </div>
          ) : data.diagnostics ? (
            <Diagnostics d={data.diagnostics} />
          ) : (
            <p className="text-[13px] text-mute">No results.</p>
          )}
        </div>
      )}
    </div>
  );
}
