'use client';

import { useEffect, useState } from 'react';

interface SourceRow {
  hpcp_source: string; n: number; decided_pct: number | null;
  avg_conf: number | null; playable: number;
}

interface Stats {
  sources?: SourceRow[];
  stats: Record<string, string | number>;
  modes: { mode: string; n: number; avg_conf: number | null }[];
  bpm: { bucket: number; n: number }[];
  tags: { tag: string; n: number }[];
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-3.5">
      <p className="text-[10px] uppercase tracking-wider text-mute">{label}</p>
      <p className="num text-[22px] mt-0.5 text-ink">{value}</p>
      {sub && <p className="text-[11px] text-mute leading-snug mt-0.5">{sub}</p>}
    </div>
  );
}

export default function CorpusPage() {
  const [d, setD] = useState<Stats | null>(null);
  useEffect(() => { fetch('/api/stats').then((r) => r.json()).then(setD).catch(() => {}); }, []);

  if (!d?.stats) return <div className="mx-auto max-w-4xl px-5 py-10 text-[13px] text-mute pulse">loading corpus…</div>;
  const s = d.stats;
  const maxMode = Math.max(...d.modes.map((m) => m.n), 1);
  const maxBpm = Math.max(...d.bpm.map((b) => b.n), 1);
  const maxTag = Math.max(...d.tags.map((t) => t.n), 1);

  return (
    <div className="mx-auto max-w-4xl px-5 py-10 space-y-5">
      <div>
        <h1 className="text-[24px] font-semibold tracking-tight">The corpus</h1>
        <p className="mt-2 text-[13.5px] text-dim leading-relaxed max-w-2xl">
          Creative Commons releases from the Internet Archive&apos;s <code>netlabels</code> collection — 77,000
          items of independent, mostly electronic music. Every track below was decoded and analysed by the
          pipeline in this repository; none of these numbers come from an external metadata service.
        </p>
      </div>

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <Stat label="analysed" value={String(s.tracks_analyzed)} sub={`${s.tracks_total} discovered`} />
        <Stat label="searchable" value={String(s.tracks_embedded)} sub="analysed and embedded" />
        <Stat label="artists" value={String(s.artists_total)} />
        <Stat label="mode assigned" value={`${s.mode_decided_pct}%`} sub="the rest abstain rather than guess" />
        <Stat label="hand labels" value={String(s.labeled_total)} sub="ground truth for evaluation" />
        <Stat label="queries logged" value={String(s.queries_total)} />
        <Stat label="relevance events" value={String(s.feedback_total)} sub="the accumulating dataset" />
        <Stat label="mean tempo" value={`${s.mean_bpm ?? '—'}`} sub="BPM" />
      </div>

      {d.sources && d.sources.length > 1 && (
        <div className="card p-4">
          <h2 className="text-[13px] font-medium mb-1">Two tiers, different amounts of information</h2>
          <p className="text-[11.5px] text-mute mb-3 leading-relaxed">
            These are never pooled in an evaluation. <code className="text-dim">audio</code> rows were
            decoded here and carry per-frame HPCP with bass-register, downbeat and phrase-final
            weighting. <code className="text-dim">acousticbrainz</code> rows reuse Essentia&apos;s
            published <em>aggregate</em> profile — about half the tonal information, and no structural
            prior is reconstructible from it — but they bring real MusicBrainz identities and a trained
            vocal classifier.
          </p>
          <div className="scroll-x">
            <table className="w-full text-[12px] min-w-[440px]">
              <thead>
                <tr className="text-mute text-[10px] uppercase tracking-wider border-b border-line">
                  <th className="text-left font-normal py-1.5">source</th>
                  <th className="text-right font-normal">tracks</th>
                  <th className="text-right font-normal">playable</th>
                  <th className="text-right font-normal">mode assigned</th>
                  <th className="text-right font-normal">mean conf.</th>
                </tr>
              </thead>
              <tbody className="num">
                {d.sources.map((s) => (
                  <tr key={s.hpcp_source} className="border-b border-line/50 last:border-0">
                    <td className="py-1.5 text-dim">{s.hpcp_source}</td>
                    <td className="text-right text-ink">{s.n.toLocaleString()}</td>
                    <td className="text-right text-mute">{s.playable.toLocaleString()}</td>
                    <td className="text-right text-accent">{s.decided_pct ?? '—'}%</td>
                    <td className="text-right text-mute">{s.avg_conf ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="card p-4">
          <h2 className="text-[13px] font-medium mb-1">Modes detected</h2>
          <p className="text-[11px] text-mute mb-3 leading-relaxed">
            A major/minor-only detector could produce just the first two of these. Everything below Aeolian is
            a distinction the baseline cannot represent at all.
          </p>
          <div className="space-y-1.5">
            {d.modes.map((m) => (
              <div key={m.mode} className="flex items-center gap-2 text-[11.5px]">
                <span className={`w-32 shrink-0 truncate ${m.mode === 'unclear' ? 'text-mute' : 'text-dim'}`}>
                  {m.mode?.replace(/_/g, ' ') ?? 'unclear'}
                </span>
                <span className="flex-1 h-[7px] rounded-full bg-surface-2 overflow-hidden">
                  <span className="block h-full rounded-full"
                        style={{ width: `${(m.n / maxMode) * 100}%`, background: m.mode === 'unclear' ? 'var(--line-2)' : 'var(--accent)' }} />
                </span>
                <span className="num text-mute w-9 text-right">{m.n}</span>
                <span className="num text-mute w-9 text-right text-[10px]">{m.avg_conf?.toFixed(2) ?? '—'}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card p-4">
          <h2 className="text-[13px] font-medium mb-1">Tempo distribution</h2>
          <p className="text-[11px] text-mute mb-3">60–200 BPM, measured by autocorrelation over spectral flux.</p>
          <div className="flex items-end gap-[3px] h-32">
            {d.bpm.map((b) => (
              <div key={b.bucket} className="flex-1 rounded-t-sm"
                   title={`${60 + (b.bucket - 1) * 10}–${60 + b.bucket * 10} BPM: ${b.n}`}
                   style={{ height: `${Math.max(3, (b.n / maxBpm) * 100)}%`, background: 'var(--cyan)', opacity: 0.75 }} />
            ))}
          </div>
          <div className="flex justify-between num text-[10px] text-mute mt-1">
            <span>60</span><span>130</span><span>200</span>
          </div>
        </div>
      </div>

      <div className="card p-4">
        <h2 className="text-[13px] font-medium mb-1">Most common release tags</h2>
        <p className="text-[11px] text-mute mb-3">
          Self-declared by the labels, not inferred. These feed the tag constraint; everything else in the
          system is measured from audio.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {d.tags.map((t) => (
            <span key={t.tag} className="chip" style={{ color: 'var(--text-dim)', opacity: 0.5 + 0.5 * (t.n / maxTag) }}>
              {t.tag} <span className="text-mute">{t.n}</span>
            </span>
          ))}
        </div>
      </div>

      <p className="text-[11.5px] text-mute leading-relaxed">
        The corpus is uneven, and the write-up should not pretend otherwise. Net label catalogues include
        unfinished sketches, live sets and field recordings alongside finished records. A high abstention rate on
        modal analysis is partly the classifier being careful and partly the material genuinely having no tonal
        centre to find.
      </p>
    </div>
  );
}
