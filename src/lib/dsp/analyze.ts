/**
 * Node-only entry point: fetch audio by URL, decode it with ffmpeg, then hand the
 * PCM to the browser-safe pipeline in `core.ts`.
 *
 * Anything that needs to run in the browser must import from './core' instead --
 * this module pulls in node:child_process transitively via ./decode.
 */

import { decodeAudio, probeDuration, excerptOffset } from './decode';
import { analyzePcm, AnalysisResult, SAMPLE_RATE, EXCERPT_SECONDS } from './core';

export * from './core';

export interface AnalyzeOptions {
  userAgent?: string;
  knownDurationSec?: number | null;
  offsetSec?: number;
  seconds?: number;
  timeoutMs?: number;
}

export async function analyzeUrl(url: string, opt: AnalyzeOptions = {}): Promise<AnalysisResult> {
  const t0 = Date.now();
  const ua = opt.userAgent ?? 'CRATE/0.1';
  let duration = opt.knownDurationSec ?? null;
  if (duration == null) duration = await probeDuration(url, ua);
  const tProbe = Date.now();

  const seconds = opt.seconds ?? EXCERPT_SECONDS;
  const offset = opt.offsetSec ?? excerptOffset(duration);
  const x = await decodeAudio(url, {
    offsetSec: offset, durationSec: seconds, sampleRate: SAMPLE_RATE,
    userAgent: ua, timeoutMs: opt.timeoutMs ?? 90_000,
  });
  const tDecode = Date.now();

  const res = analyzePcm(x, SAMPLE_RATE);
  const tAnalyze = Date.now();

  return {
    ...res,
    durationSec: duration,
    excerptOffsetSec: Number(offset.toFixed(2)),
    excerptSeconds: Number((x.length / SAMPLE_RATE).toFixed(2)),
    timings: {
      probeMs: tProbe - t0,
      decodeMs: tDecode - tProbe,
      analyzeMs: tAnalyze - tDecode,
      totalMs: tAnalyze - t0,
      ...res.timings,
    },
  };
}
