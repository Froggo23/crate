'use client';

import { useState } from 'react';
import { usePlayer, fmtTime } from './player';
import { HpcpWheel, ConfidenceMeter, ModeHypotheses } from './viz';
import type { SearchRow } from '@/lib/search';

const pct = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v * 100)}`);

function Meter({ label, value, colour }: { label: string; value: number | null; colour: string }) {
  const v = Math.max(0, Math.min(1, value ?? 0));
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] uppercase tracking-wider text-mute w-16 shrink-0">{label}</span>
      <span className="flex-1 h-[5px] rounded-full bg-surface-2 overflow-hidden min-w-12">
        <span className="block h-full rounded-full" style={{ width: `${v * 100}%`, background: colour }} />
      </span>
      <span className="num text-[10px] text-dim w-6 text-right">{pct(value)}</span>
    </div>
  );
}

export function ResultCard({
  row, index, queryId, sessionId,
}: {
  row: SearchRow; index: number; queryId: string | null; sessionId: string;
}) {
  const player = usePlayer();
  const [open, setOpen] = useState(false);
  const [vote, setVote] = useState<'up' | 'down' | null>(null);
  const isCurrent = player.trackId === row.track_id;

  async function feedback(event: 'up' | 'down') {
    const next = vote === event ? null : event;
    setVote(next);
    if (!next) return;
    try {
      await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          queryId, trackId: row.track_id, sessionId, event: next,
          position: index + 1, dwellMs: isCurrent ? player.dwellMs() : null,
        }),
      });
    } catch { /* feedback is best-effort; never block the UI on it */ }
  }

  const unclear = row.mode === 'unclear';
  const modeLabel = unclear ? 'mode unclear' : row.key_name ?? '—';
  const disagrees =
    !unclear && row.baseline_key_name && row.key_name &&
    row.baseline_key_name.split(' ')[0] !== row.key_name.split(' ')[0];

  return (
    <article className="card p-3.5 fade-in hover:border-line-2 transition-colors">
      <div className="flex gap-3">
        <button
          onClick={() => player.toggle(row.track_id, row.audio_url)}
          aria-label={isCurrent && player.playing ? `Pause ${row.title}` : `Play ${row.title}`}
          className="shrink-0 w-11 h-11 rounded-lg grid place-items-center border transition-colors"
          style={{
            borderColor: isCurrent ? 'var(--accent)' : 'var(--line-2)',
            background: isCurrent ? 'color-mix(in srgb, var(--accent) 16%, transparent)' : 'var(--surface-2)',
            color: isCurrent ? 'var(--accent)' : 'var(--text-dim)',
          }}
        >
          {isCurrent && player.loading
            ? <span className="pulse text-[10px] num">•••</span>
            : isCurrent && player.playing
              ? <svg width="13" height="13" viewBox="0 0 12 12" fill="currentColor"><rect x="1" y="1" width="3.5" height="10" rx="1" /><rect x="7.5" y="1" width="3.5" height="10" rx="1" /></svg>
              : <svg width="13" height="13" viewBox="0 0 12 12" fill="currentColor"><path d="M2 1.2v9.6a.6.6 0 0 0 .92.5l7.3-4.8a.6.6 0 0 0 0-1L2.92.7A.6.6 0 0 0 2 1.2Z" /></svg>}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <span className="num text-[11px] text-mute mt-0.5 w-5 shrink-0">{index + 1}</span>
            <div className="min-w-0 flex-1">
              <h3 className="text-[14px] font-medium leading-tight truncate">{row.title}</h3>
              <p className="text-[12px] text-dim truncate">
                {row.artist_name}
                {row.year ? <span className="text-mute"> · {row.year}</span> : null}
                {row.emergence_percentile != null && (
                  <span className="text-mute"> · popularity pct {row.emergence_percentile.toFixed(0)}</span>
                )}
              </p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button onClick={() => feedback('up')} aria-label="Relevant" title="Relevant"
                      className="w-7 h-7 grid place-items-center rounded-md border transition-colors"
                      style={{ borderColor: vote === 'up' ? 'var(--green)' : 'var(--line)', color: vote === 'up' ? 'var(--green)' : 'var(--text-mute)' }}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2.5 10 6.5l4.4.6-3.2 3.1.8 4.3L8 12.5 4 14.5l.8-4.3L1.6 7.1 6 6.5Z" /></svg>
              </button>
              <button onClick={() => feedback('down')} aria-label="Not relevant" title="Not relevant"
                      className="w-7 h-7 grid place-items-center rounded-md border transition-colors"
                      style={{ borderColor: vote === 'down' ? 'var(--red)' : 'var(--line)', color: vote === 'down' ? 'var(--red)' : 'var(--text-mute)' }}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="7" width="10" height="2" rx="1" /></svg>
              </button>
            </div>
          </div>

          {/* The transparency row. Plan phase 4: showing the detected BPM, key,
              mode and confidence is the product differentiator, not a debug view. */}
          <div className="flex flex-wrap items-center gap-1.5 mt-2">
            <span className="chip" style={{ color: 'var(--text-dim)' }}>
              {row.bpm ? row.bpm.toFixed(0) : '—'} BPM
            </span>
            <span className="chip" style={{
              color: unclear ? 'var(--text-mute)' : 'var(--accent)',
              borderColor: unclear ? 'var(--line)' : 'color-mix(in srgb, var(--accent) 45%, var(--line-2))',
            }}>
              {modeLabel}
              {!unclear && <ConfidenceMeter value={row.mode_confidence} width={34} />}
            </span>
            {row.instrumental_likelihood != null && (
              <span className="chip" style={{ color: 'var(--text-dim)' }}>
                {row.instrumental_likelihood >= 0.6 ? 'instrumental' : row.instrumental_likelihood <= 0.45 ? 'has vocals' : 'vocals?'}
              </span>
            )}
            {row.duration_sec ? <span className="chip" style={{ color: 'var(--text-mute)' }}>{fmtTime(row.duration_sec)}</span> : null}
            {row.license_short && <span className="chip" style={{ color: 'var(--text-mute)' }}>{row.license_short}</span>}
            {row.relaxed && (
              <span className="chip" title="only matches after a constraint was loosened"
                    style={{ color: 'var(--accent)', borderColor: 'color-mix(in srgb, var(--accent) 45%, var(--line-2))' }}>
                relaxed match
              </span>
            )}
            <button onClick={() => setOpen((o) => !o)}
                    className="chip hover:border-accent transition-colors"
                    style={{ color: open ? 'var(--accent)' : 'var(--text-mute)' }}>
              {open ? 'hide analysis' : 'analysis'}
            </button>
          </div>

          {row.reason && (
            <p className="mt-2 text-[12.5px] leading-relaxed text-dim border-l-2 pl-2.5"
               style={{ borderColor: 'color-mix(in srgb, var(--accent) 50%, transparent)' }}>
              {row.reason}
            </p>
          )}

          {isCurrent && (
            <div className="mt-2 flex items-center gap-2">
              <span className="num text-[10px] text-mute w-8">{fmtTime(player.currentTime)}</span>
              <input
                type="range" min={0} max={player.duration || row.duration_sec || 100}
                value={player.currentTime} onChange={(e) => player.seek(Number(e.target.value))}
                aria-label="Seek" className="flex-1 h-1 accent-[var(--accent)] cursor-pointer"
              />
              <span className="num text-[10px] text-mute w-8">{fmtTime(player.duration || row.duration_sec || 0)}</span>
            </div>
          )}
          {isCurrent && player.error && <p className="mt-1 text-[11px]" style={{ color: 'var(--red)' }}>{player.error}</p>}
        </div>
      </div>

      {open && (
        <div className="mt-3 pt-3 border-t border-line grid gap-4 sm:grid-cols-[190px_1fr] fade-in">
          <div className="flex flex-col items-center gap-1">
            <HpcpWheel hpcp={row.hpcp} tonic={row.tonic} mode={row.mode} size={190} />
            <span className="text-[10px] text-mute text-center leading-tight">
              harmonic pitch class profile<br />
              <span className="text-accent">tonic</span> · <span style={{ color: 'var(--cyan)' }}>in scale</span>
            </span>
          </div>
          <div className="space-y-3 min-w-0">
            <div className="space-y-1.5">
              <Meter label="energy" value={row.energy} colour="var(--accent)" />
              <Meter label="bright" value={row.brightness} colour="var(--cyan)" />
              <Meter label="percussive" value={row.percussive_ratio} colour="var(--violet)" />
              <Meter label="instr." value={row.instrumental_likelihood} colour="var(--green)" />
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-mute mb-1.5">mode hypotheses</p>
              <ModeHypotheses scores={row.mode_scores} />
            </div>
            <div className="text-[11px] text-mute space-y-0.5">
              <p>
                Krumhansl–Schmuckler baseline said <span className="text-dim">{row.baseline_key_name ?? '—'}</span>
                {disagrees && <span style={{ color: 'var(--accent)' }}> — disagrees with CRATE</span>}
              </p>
              <p>centroid {row.spectral_centroid?.toFixed(0) ?? '—'} Hz · loudness {row.loudness_db?.toFixed(1) ?? '—'} dB</p>
              {row.tags?.length ? <p className="truncate">tags: {row.tags.slice(0, 8).join(', ')}</p> : null}
              {row.page_url && (
                <a href={row.page_url} target="_blank" rel="noreferrer noopener"
                   className="inline-block mt-1 hover:text-accent transition-colors underline underline-offset-2">
                  source on archive.org ↗
                </a>
              )}
            </div>
          </div>
        </div>
      )}
    </article>
  );
}
