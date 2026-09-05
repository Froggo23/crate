'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePlayer, fmtTime } from '@/components/player';
import { PITCH_NAMES, MODE_NAMES } from '@/lib/llm/schema';
import type { EvalReport } from '@/lib/eval';
import bench from '@/../data/benchmark.json';

interface Candidate {
  id: string; title: string; artist_name: string; audio_url: string; duration_sec: number | null;
  bpm: number | null; tonic: number | null; mode: string | null; mode_confidence: number | null;
  key_name: string | null; baseline_key_name: string | null; hpcp: number[] | null;
}

const pctS = (n: number) => `${n.toFixed(1)}%`;

function Bench() {
  const b = bench as unknown as {
    clear: { ourTonic: number; ourMode: number; baseTonic: number; baseMode: number; n: number };
    ambiguous: { ourTonic: number; ourMode: number; baseTonic: number; baseMode: number; n: number };
  };
  const rows = [
    { label: 'Clear material — the tonic is also the loudest pitch class', d: b.clear },
    { label: 'Ambiguous material — harmony dwells on the parent major triad', d: b.ambiguous },
  ];
  return (
    <div className="card p-4">
      <h2 className="text-[15px] font-medium">Synthetic benchmark</h2>
      <p className="mt-1.5 text-[12.5px] text-dim leading-relaxed">
        Audio synthesised directly <em>from</em> a known tonic and mode, so ground truth is not in dispute.
        The ambiguous set is the case the whole project exists for: pitch class content identical to the parent
        major scale, with the modal tonic established only by bass register, downbeat placement and phrase-final
        resolution. Reproduce with <code className="text-accent">npx tsx scripts/test-dsp.ts</code>.
      </p>
      <div className="scroll-x mt-3">
        <table className="w-full text-[12px] min-w-[520px]">
          <thead>
            <tr className="text-mute text-[10px] uppercase tracking-wider border-b border-line">
              <th className="text-left font-normal py-1.5">condition</th>
              <th className="text-right font-normal">CRATE tonic</th>
              <th className="text-right font-normal">K–S tonic</th>
              <th className="text-right font-normal">CRATE mode</th>
              <th className="text-right font-normal">K–S mode</th>
            </tr>
          </thead>
          <tbody className="num">
            {rows.map((r) => (
              <tr key={r.label} className="border-b border-line/50 last:border-0">
                <td className="py-2 pr-3 text-dim">{r.label}</td>
                <td className="text-right text-accent">{r.d.ourTonic}/{r.d.n}</td>
                <td className="text-right text-dim">{r.d.baseTonic}/{r.d.n}</td>
                <td className="text-right text-accent">{r.d.ourMode}/{r.d.n}</td>
                <td className="text-right text-dim">{r.d.baseMode}/{r.d.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2.5 text-[11px] text-mute leading-relaxed">
        The baseline&apos;s mode ceiling is 2/8 by construction — it has only major and minor templates, so it
        cannot emit &ldquo;Dorian&rdquo; at all. That is the structural limitation being demonstrated, not a
        scoring trick. Its tonic score is the fair comparison, and it loses 3 of 8 on ambiguous material by
        collapsing onto the relative major.
      </p>
    </div>
  );
}

function Labeller({ onLabelled }: { onLabelled: () => void }) {
  const [tracks, setTracks] = useState<Candidate[]>([]);
  const [i, setI] = useState(0);
  const [tonic, setTonic] = useState<string>('C');
  const [mode, setMode] = useState<string>('aeolian');
  const [saving, setSaving] = useState(false);
  const [counts, setCounts] = useState<{ labelled: number } | null>(null);
  const player = usePlayer();

  const load = useCallback(async () => {
    const r = await fetch('/api/labels?limit=20').then((x) => x.json());
    setTracks(r.tracks ?? []); setCounts(r.counts ?? null); setI(0);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const t = tracks[i];
  async function save() {
    if (!t) return;
    setSaving(true);
    try {
      await fetch('/api/labels', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackId: t.id, tonic, mode, labeler: 'web' }),
      });
      player.stop();
      if (i + 1 >= tracks.length) await load(); else setI(i + 1);
      onLabelled();
    } finally { setSaving(false); }
  }

  if (!t) {
    return (
      <div className="card p-4">
        <p className="text-[13px] text-dim">Nothing left to label right now.</p>
        <button onClick={() => void load()} className="chip mt-2 hover:border-accent">reload</button>
      </div>
    );
  }

  const isCurrent = player.trackId === t.id;
  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h2 className="text-[15px] font-medium">Label by ear</h2>
        <span className="num text-[11px] text-mute">
          {counts?.labelled ?? 0} labelled · {tracks.length - i} queued
        </span>
      </div>
      <p className="text-[12.5px] text-dim leading-relaxed">
        Listen, then name the tonal centre and mode you hear. You are shown the tracks the classifier is
        <em> least</em> sure about, because those labels carry the most information. Your answer is hidden from
        you until you submit — the prediction below is deliberately not revealed first.
      </p>

      <div className="flex items-center gap-3">
        <button onClick={() => player.toggle(t.id, t.audio_url)}
                className="w-12 h-12 shrink-0 rounded-lg grid place-items-center border"
                style={{ borderColor: isCurrent ? 'var(--accent)' : 'var(--line-2)', color: isCurrent ? 'var(--accent)' : 'var(--text-dim)' }}>
          {isCurrent && player.playing ? '❙❙' : '▶'}
        </button>
        <div className="min-w-0">
          <p className="text-[14px] truncate">{t.title}</p>
          <p className="text-[12px] text-dim truncate">
            {t.artist_name} · {t.bpm?.toFixed(0) ?? '—'} BPM · {t.duration_sec ? fmtTime(t.duration_sec) : '—'}
          </p>
        </div>
      </div>
      {isCurrent && (
        <input type="range" min={0} max={player.duration || 100} value={player.currentTime}
               onChange={(e) => player.seek(Number(e.target.value))}
               aria-label="Seek" className="w-full h-1 accent-[var(--accent)]" />
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-[11px] uppercase tracking-wider text-mute">
          tonal centre
          <select value={tonic} onChange={(e) => setTonic(e.target.value)}
                  className="mt-1 w-full bg-surface-2 border border-line rounded-lg px-2.5 py-2 text-[13px] text-ink normal-case tracking-normal">
            {PITCH_NAMES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="text-[11px] uppercase tracking-wider text-mute">
          mode
          <select value={mode} onChange={(e) => setMode(e.target.value)}
                  className="mt-1 w-full bg-surface-2 border border-line rounded-lg px-2.5 py-2 text-[13px] text-ink normal-case tracking-normal">
            {MODE_NAMES.map((m) => <option key={m} value={m}>{m.replace(/_/g, ' ')}</option>)}
          </select>
        </label>
      </div>

      <div className="flex gap-2">
        <button onClick={() => void save()} disabled={saving}
                className="px-4 py-2 rounded-lg text-[13px] font-medium disabled:opacity-40"
                style={{ background: 'var(--accent)', color: '#17130a' }}>
          {saving ? 'saving…' : 'Save label'}
        </button>
        <button onClick={() => { player.stop(); setI(i + 1 >= tracks.length ? 0 : i + 1); }}
                className="px-4 py-2 rounded-lg text-[13px] border border-line-2 text-dim hover:text-ink">
          skip
        </button>
      </div>
    </div>
  );
}

export default function EvalPage() {
  const [report, setReport] = useState<EvalReport | null>(null);
  const load = useCallback(() => {
    fetch('/api/eval').then((r) => r.json()).then(setReport).catch(() => {});
  }, []);
  useEffect(load, [load]);

  return (
    <div className="mx-auto max-w-4xl px-5 py-10 space-y-5">
      <div>
        <h1 className="text-[24px] font-semibold tracking-tight">Evaluation</h1>
        <p className="mt-2 text-[13.5px] text-dim leading-relaxed max-w-2xl">
          Two systems, one set of labels, identical input. CRATE&apos;s joint tonic×mode classifier against a
          Krumhansl–Schmuckler key detector — the algorithm family behind Essentia&apos;s <code>KeyExtractor</code>,
          and therefore behind most published MIR features. Both read the same harmonic pitch class profile,
          so the comparison isolates the classifier rather than the front end.
        </p>
      </div>

      <Bench />

      {report && report.labelled > 0 ? (
        <div className="card p-4">
          <h2 className="text-[15px] font-medium">Hand-labelled set — {report.labelled} tracks</h2>
          <div className="scroll-x mt-3">
            <table className="w-full text-[12px] min-w-[560px]">
              <thead>
                <tr className="text-mute text-[10px] uppercase tracking-wider border-b border-line">
                  <th className="text-left font-normal py-1.5">mode</th>
                  <th className="text-right font-normal">n</th>
                  <th className="text-right font-normal">CRATE P</th>
                  <th className="text-right font-normal">CRATE R</th>
                  <th className="text-right font-normal">CRATE F1</th>
                  <th className="text-right font-normal">K–S P</th>
                  <th className="text-right font-normal">K–S R</th>
                  <th className="text-right font-normal">K–S F1</th>
                </tr>
              </thead>
              <tbody className="num">
                {report.perMode.map((m) => (
                  <tr key={m.mode} className="border-b border-line/50 last:border-0">
                    <td className="py-1.5 text-dim">
                      {m.mode.replace(/_/g, ' ')}
                      {!m.baseline.expressible && <span className="text-mute" title="the baseline has no template for this mode"> *</span>}
                    </td>
                    <td className="text-right text-mute">{m.support}</td>
                    <td className="text-right text-accent">{m.crate.precision.toFixed(2)}</td>
                    <td className="text-right text-accent">{m.crate.recall.toFixed(2)}</td>
                    <td className="text-right text-accent">{m.crate.f1.toFixed(2)}</td>
                    <td className="text-right text-dim">{m.baseline.precision.toFixed(2)}</td>
                    <td className="text-right text-dim">{m.baseline.recall.toFixed(2)}</td>
                    <td className="text-right text-dim">{m.baseline.f1.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 mt-4 text-[12px]">
            <div className="space-y-1">
              <p className="text-[10px] uppercase tracking-wider text-mute">CRATE</p>
              <p className="text-dim">tonic accuracy <span className="num text-accent">{pctS(report.overall.crate.tonicAccuracy)}</span></p>
              <p className="text-dim">mode accuracy <span className="num text-accent">{pctS(report.overall.crate.modeAccuracy)}</span></p>
              <p className="text-dim">mode accuracy where it committed <span className="num text-accent">{pctS(report.overall.crate.modeAccuracyOnDecided)}</span></p>
              <p className="text-dim">abstained <span className="num">{pctS(report.overall.crate.abstentionRate)}</span></p>
            </div>
            <div className="space-y-1">
              <p className="text-[10px] uppercase tracking-wider text-mute">Krumhansl–Schmuckler</p>
              <p className="text-dim">tonic accuracy <span className="num">{pctS(report.overall.baseline.tonicAccuracy)}</span></p>
              <p className="text-dim">mode accuracy <span className="num">{pctS(report.overall.baseline.modeAccuracy)}</span></p>
              <p className="text-mute">collapsed onto the parent major / its relative minor: <span className="num">{report.relativeCollapse.n}/{report.relativeCollapse.of}</span></p>
            </div>
          </div>
          <ul className="mt-3 space-y-1 text-[11px] text-mute leading-relaxed list-disc pl-4">
            {report.notes.map((n) => <li key={n}>{n}</li>)}
          </ul>
        </div>
      ) : (
        <div className="card p-4">
          <h2 className="text-[15px] font-medium">Hand-labelled set — empty</h2>
          <p className="mt-1.5 text-[12.5px] text-dim leading-relaxed">
            The real evaluation needs human labels, and there are none yet. The plan calls for 200 tracks across
            modes and is blunt that this is &ldquo;tedious and the most valuable thing you will make&rdquo;.
            The tool below is how it gets built. Label a few and this table fills in.
          </p>
        </div>
      )}

      <Labeller onLabelled={load} />

      {report && report.confusion.length > 0 && (
        <div className="card p-4">
          <h2 className="text-[11px] uppercase tracking-wider text-mute mb-2">confusions — heard vs predicted</h2>
          <div className="flex flex-wrap gap-1.5">
            {report.confusion.slice(0, 20).map((c) => (
              <span key={`${c.truth}-${c.predicted}`} className="chip"
                    style={{ color: c.truth === c.predicted ? 'var(--green)' : 'var(--text-dim)' }}>
                {c.truth.replace(/_/g, ' ')} → {c.predicted?.replace(/_/g, ' ') ?? 'unclear'} <span className="text-mute">×{c.n}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
