/**
 * Browser-side decoding, so the analysis page runs the real pipeline client-side.
 *
 * Vercel functions have no ffmpeg, and bundling a ~78 MB static build into every
 * serverless invocation to analyse one track is the wrong trade. The Web Audio
 * API already contains a production-grade decoder and resampler: constructing an
 * OfflineAudioContext at 22.05 kHz makes decodeAudioData resample for us, which
 * is exactly the front end `decode.ts` asks ffmpeg for on the server.
 *
 * Same `analyzePcm` runs in both places, so the numbers match.
 */

import { SAMPLE_RATE, EXCERPT_SECONDS } from './core';

export interface DecodedExcerpt {
  pcm: Float64Array;
  sampleRate: number;
  fullDurationSec: number;
  offsetSec: number;
  bytes: number;
}

export async function decodeExcerptInBrowser(
  url: string,
  opts: { seconds?: number; offsetFraction?: number; signal?: AbortSignal } = {},
): Promise<DecodedExcerpt> {
  const seconds = opts.seconds ?? EXCERPT_SECONDS;
  const res = await fetch(url, { signal: opts.signal, mode: 'cors' });
  if (!res.ok) throw new Error(`could not fetch audio (${res.status})`);
  const bytes = await res.arrayBuffer();

  const Ctx: typeof OfflineAudioContext =
    (window as unknown as { OfflineAudioContext: typeof OfflineAudioContext }).OfflineAudioContext ??
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  if (!Ctx) throw new Error('this browser has no Web Audio decoder');

  // a 1-frame context is enough: we only want its sample rate for the resample
  const ctx = new Ctx(1, 1, SAMPLE_RATE);
  const buffer: AudioBuffer = await new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(bytes.slice(0), resolve, reject);
    // modern browsers return a promise; Safari uses the callbacks above
    if (p && typeof (p as Promise<AudioBuffer>).then === 'function') {
      (p as Promise<AudioBuffer>).then(resolve, reject);
    }
  });

  const sr = buffer.sampleRate;
  const total = buffer.duration;
  const offset = total > seconds * 1.5
    ? Math.min(total * (opts.offsetFraction ?? 0.25), Math.max(0, total - seconds - 5))
    : 0;

  const start = Math.floor(offset * sr);
  const wanted = Math.min(Math.floor(seconds * sr), buffer.length - start);
  if (wanted < sr * 5) throw new Error('audio is too short to analyse (need at least 5 s)');

  // downmix to mono
  const pcm = new Float64Array(wanted);
  const chans = buffer.numberOfChannels;
  for (let c = 0; c < chans; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < wanted; i++) pcm[i] += data[start + i] / chans;
  }

  return { pcm, sampleRate: sr, fullDurationSec: total, offsetSec: offset, bytes: bytes.byteLength };
}

export async function decodeFileInBrowser(
  file: File,
  opts: { seconds?: number } = {},
): Promise<DecodedExcerpt> {
  const url = URL.createObjectURL(file);
  try {
    return await decodeExcerptInBrowser(url, opts);
  } finally {
    URL.revokeObjectURL(url);
  }
}
