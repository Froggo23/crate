'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { decodeExcerptInBrowser, decodeFileInBrowser } from '@/lib/dsp/browser';
import { analyzePcm, SAMPLE_RATE } from '@/lib/dsp/core';
import { HpcpWheel, ConfidenceMeter } from '@/components/viz';
import { PITCH_NAMES } from '@/lib/llm/schema';

type Result = ReturnType<typeof analyzePcm>;

function Chromagram({ frames }: { frames: number[][] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !frames.length) return;
    const w = frames.length, h = 12;
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(w, h);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        const v = Math.max(0, Math.min(1, frames[x][11 - y] ?? 0));
        const i = (y * w + x) * 4;
        // dark -> amber ramp, matching the rest of the interface
        img.data[i] = Math.round(20 + 204 * v);
        img.data[i + 1] = Math.round(20 + 144 * v);
        img.data[i + 2] = Math.round(24 + 50 * v);
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [frames]);

  return (
    <div className="flex gap-2 items-stretch">
      <div className="flex flex-col justify-between text-[9px] num text-mute py-[1px]">
        {[...PITCH_NAMES].reverse().map((n) => <span key={n} className="leading-none">{n}</span>)}
      </div>
      <canvas ref={ref} className="flex-1 rounded-md border border-line"
              style={{ imageRendering: 'pixelated', height: 132, width: '100%' }} />
    </div>
  );
}

function Row({ k, v, hint }: { k: string; v: string; hint?: string }) {
  return (
    <div className="flex justify-between gap-3 py-[3px] border-b border-line/60 last:border-0">
      <span className="text-[11.5px] text-mute shrink-0">{k}</span>
      <span className="num text-[11.5px] text-dim text-right">{v}{hint && <span className="text-mute"> {hint}</span>}</span>
    </div>
  );
}

export default function AnalyzePage() {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [meta, setMeta] = useState<{ decodeMs: number; analyzeMs: number; bytes: number; duration: number; offset: number; label: string } | null>(null);
  const [samples, setSamples] = useState<{ id: string; title: string; artist_name: string; audio_url: string }[]>([]);

  useEffect(() => {
    fetch('/api/labels?limit=6').then((r) => r.json())
      .then((d) => setSamples(d.tracks ?? [])).catch(() => {});
  }, []);

  const run = useCallback(async (source: string | File, label: string) => {
    setError(null); setResult(null); setMeta(null);
    setStatus('fetching audio…');
    try {
      const t0 = performance.now();
      const dec = typeof source === 'string'
        ? await decodeExcerptInBrowser(source)
        : await decodeFileInBrowser(source);
      const t1 = performance.now();
      setStatus(`analysing ${(dec.pcm.length / SAMPLE_RATE).toFixed(0)}s of audio…`);
      // yield so the status paints before the synchronous DSP blocks the thread
      await new Promise((r) => setTimeout(r, 16));
      const res = analyzePcm(dec.pcm, SAMPLE_RATE);
      const t2 = performance.now();
      setResult(res);
      setMeta({
        decodeMs: Math.round(t1 - t0), analyzeMs: Math.round(t2 - t1),
        bytes: dec.bytes, duration: dec.fullDurationSec, offset: dec.offsetSec, label,
      });
      setStatus(null);
    } catch (e) {
      setError((e as Error).message);
      setStatus(null);
    }
  }, []);

  return (
    <div className="mx-auto max-w-4xl px-5 py-10">
      <h1 className="text-[24px] font-semibold tracking-tight">Analyze any track</h1>
      <p className="mt-2 text-[13.5px] text-dim leading-relaxed max-w-2xl">
        This runs CRATE&apos;s entire signal chain <strong className="text-ink">in your browser</strong> — FFT,
        harmonic pitch class profile, beat tracking, joint tonic×mode classification, and the
        Krumhansl–Schmuckler baseline it is measured against. No audio is uploaded anywhere.
      </p>

      <div className="mt-5 card p-4 space-y-3">
        <div className="flex gap-2 flex-wrap">
          <input
            value={url} onChange={(e) => setUrl(e.target.value)}
            placeholder="https://… direct link to an audio file (must allow cross-origin)"
            aria-label="Audio URL"
            className="flex-1 min-w-[240px] bg-surface-2 border border-line rounded-lg px-3 py-2 text-[13px] placeholder:text-mute focus:border-accent transition-colors"
          />
          <button onClick={() => url.trim() && run(url.trim(), url.trim())}
                  disabled={!url.trim() || !!status}
                  className="px-4 rounded-lg text-[13px] font-medium disabled:opacity-40"
                  style={{ background: 'var(--accent)', color: '#17130a' }}>
            Analyze
          </button>
          <label className="px-4 py-2 rounded-lg text-[13px] border border-line-2 text-dim hover:border-accent hover:text-accent transition-colors cursor-pointer">
            or choose a file
            <input type="file" accept="audio/*" className="hidden"
                   onChange={(e) => { const f = e.target.files?.[0]; if (f) void run(f, f.name); }} />
          </label>
        </div>

        {samples.length > 0 && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-mute mb-1.5">
              or try one from the corpus — these are the tracks the classifier is least certain about
            </p>
            <div className="flex flex-wrap gap-1.5">
              {samples.map((s) => (
                <button key={s.id} onClick={() => run(s.audio_url, `${s.artist_name} — ${s.title}`)}
                        disabled={!!status}
                        className="chip hover:border-accent hover:text-accent transition-colors max-w-full"
                        style={{ color: 'var(--text-dim)' }}>
                  <span className="truncate">{s.artist_name} — {s.title}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {status && <p className="mt-4 text-[13px] text-accent pulse">{status}</p>}
      {error && (
        <div className="mt-4 card p-4" style={{ borderColor: 'var(--red)' }}>
          <p className="text-[13px]" style={{ color: 'var(--red)' }}>{error}</p>
          <p className="text-[11.5px] text-mute mt-1.5">
            Most failures here are CORS: a server that does not send
            <code className="mx-1 text-dim">access-control-allow-origin</code>
            cannot be read by a browser. archive.org does; most others do not. Use the file picker instead.
          </p>
        </div>
      )}

      {result && meta && (
        <div className="mt-6 space-y-4 fade-in">
          <div className="card p-4">
            <p className="text-[11px] text-mute truncate">{meta.label}</p>
            <div className="mt-2 flex flex-wrap items-baseline gap-x-5 gap-y-1">
              <span className="text-[22px] font-semibold" style={{ color: result.mode.mode === 'unclear' ? 'var(--text-mute)' : 'var(--accent)' }}>
                {result.mode.keyName}
              </span>
              <span className="flex items-center gap-2 text-[12px] text-dim">
                confidence <ConfidenceMeter value={result.mode.modeConfidence} />
                <span className="num">{result.mode.modeConfidence.toFixed(2)}</span>
              </span>
              <span className="num text-[15px] text-dim">{result.tempo.bpm.toFixed(1)} BPM</span>
            </div>
            <p className="mt-2 text-[12.5px] text-dim leading-relaxed">
              Krumhansl–Schmuckler baseline on the identical profile:{' '}
              <span className="text-ink">{result.baseline.keyName}</span>{' '}
              <span className="text-mute">(r = {result.baseline.correlation.toFixed(3)})</span>.
              {result.baseline.key !== result.mode.tonic && result.mode.mode !== 'unclear' && (
                <span style={{ color: 'var(--accent)' }}>
                  {' '}They disagree on the tonal centre — the baseline has collapsed this onto a different root.
                </span>
              )}
              {result.mode.mode === 'unclear' && (
                <span className="text-mute">
                  {' '}CRATE abstained: tonal clarity {result.mode.tonalClarity.toFixed(3)} is too low to commit to a mode.
                </span>
              )}
            </p>
            <p className="mt-1.5 num text-[10.5px] text-mute">
              decoded {(meta.bytes / 1e6).toFixed(1)} MB in {meta.decodeMs} ms · analysed in {meta.analyzeMs} ms ·
              excerpt from {meta.offset.toFixed(0)}s of {meta.duration.toFixed(0)}s · all in this browser
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-[220px_1fr]">
            <div className="card p-4 flex flex-col items-center">
              <HpcpWheel hpcp={result.hpcp} tonic={result.mode.tonic} mode={result.mode.mode} size={200} />
              <p className="text-[10px] text-mute text-center mt-1">global HPCP</p>
              <div className="mt-2 w-full text-[10.5px] space-y-0.5">
                <Row k="tonal clarity" v={result.mode.tonalClarity.toFixed(3)} />
                <Row k="flat-2 evidence" v={result.mode.flat2Evidence.toFixed(3)} />
                <Row k="tonic conf." v={result.mode.tonicConfidence.toFixed(2)} />
              </div>
            </div>

            <div className="card p-4">
              <h2 className="text-[11px] uppercase tracking-wider text-mute mb-2">
                ranked hypotheses — tonic × mode, scored jointly
              </h2>
              <div className="scroll-x">
                <table className="w-full text-[11.5px] min-w-[420px]">
                  <thead>
                    <tr className="text-mute text-[10px] uppercase tracking-wider">
                      <th className="text-left font-normal pb-1">hypothesis</th>
                      <th className="text-right font-normal pb-1">score</th>
                      <th className="text-right font-normal pb-1">corr</th>
                      <th className="text-right font-normal pb-1">prior</th>
                      <th className="text-right font-normal pb-1">diag</th>
                      <th className="text-right font-normal pb-1">scale</th>
                    </tr>
                  </thead>
                  <tbody className="num">
                    {result.mode.ranked.slice(0, 8).map((h, i) => (
                      <tr key={`${h.tonic}-${h.mode}`} className={i === 0 ? 'text-accent' : 'text-dim'}>
                        <td className="py-[3px] pr-2 whitespace-nowrap">{h.label}</td>
                        <td className="text-right">{h.score.toFixed(3)}</td>
                        <td className="text-right">{h.correlation.toFixed(3)}</td>
                        <td className="text-right">{h.prior.toFixed(2)}</td>
                        <td className="text-right">{h.diagnostic.toFixed(2)}</td>
                        <td className="text-right">{h.coverage.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[10.5px] text-mute mt-2 leading-relaxed">
                score = template correlation + {`0.34`}×structural tonic prior + {`0.22`}×characteristic-degree
                contrast + {`0.25`}×scale membership. Only the first column exists in a standard key detector.
              </p>
            </div>
          </div>

          <div className="card p-4">
            <h2 className="text-[11px] uppercase tracking-wider text-mute mb-2">chromagram — pitch class energy over time</h2>
            <Chromagram frames={result.chromagram} />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="card p-4">
              <h2 className="text-[11px] uppercase tracking-wider text-mute mb-1.5">rhythm</h2>
              <Row k="BPM" v={result.tempo.bpm.toFixed(1)} />
              <Row k="tempo conf." v={result.tempo.bpmConfidence.toFixed(2)} />
              <Row k="beats found" v={String(result.tempo.beats.length)} />
              <Row k="downbeats" v={String(result.tempo.downbeats.length)} />
              <Row k="onset rate" v={result.tempo.onsetRate.toFixed(2)} hint="/s" />
              <Row k="beat strength" v={result.tempo.beatStrength.toFixed(2)} />
            </div>
            <div className="card p-4">
              <h2 className="text-[11px] uppercase tracking-wider text-mute mb-1.5">spectrum</h2>
              <Row k="centroid" v={result.spectral.spectralCentroid.toFixed(0)} hint="Hz" />
              <Row k="rolloff 85%" v={result.spectral.spectralRolloff.toFixed(0)} hint="Hz" />
              <Row k="flatness" v={result.spectral.spectralFlatness.toFixed(4)} />
              <Row k="bandwidth" v={result.spectral.spectralBandwidth.toFixed(0)} hint="Hz" />
              <Row k="LF / HF" v={`${result.spectral.lfRatio.toFixed(2)} / ${result.spectral.hfRatio.toFixed(2)}`} />
              <Row k="percussive" v={result.spectral.percussiveRatio.toFixed(3)} />
            </div>
            <div className="card p-4">
              <h2 className="text-[11px] uppercase tracking-wider text-mute mb-1.5">dynamics &amp; derived</h2>
              <Row k="loudness" v={result.dynamics.loudnessDb.toFixed(1)} hint="dB" />
              <Row k="crest" v={result.dynamics.crestFactor.toFixed(2)} />
              <Row k="dyn. range" v={result.dynamics.dynamicRangeDb.toFixed(1)} hint="dB" />
              <Row k="energy" v={result.energy.toFixed(3)} />
              <Row k="brightness" v={result.brightness.toFixed(3)} />
              <Row k="instrumental" v={result.instrumentalLikelihood.toFixed(3)} />
            </div>
          </div>

          <p className="text-[11px] text-mute leading-relaxed">
            Instrumental likelihood is the weakest number on this page. It comes from 3–8 Hz amplitude
            modulation in the 300–3000 Hz band — the syllabic rate of singing — and a snare on the backbeat
            lands in the same place. It is a heuristic, not a vocal detector, and the README says so too.
          </p>
        </div>
      )}
    </div>
  );
}
