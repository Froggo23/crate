/**
 * Onset detection, tempo estimation, and the beat/bar grid that the structurally
 * weighted HPCP variants depend on.
 *
 * The beat grid is not here for the BPM filter alone. It is what lets the tonic
 * estimator ask "which pitch class is emphasised ON THE DOWNBEAT" and "which
 * pitch class does the phrase RESOLVE ONTO", instead of the much weaker "which
 * pitch class sounds for the longest time".
 */

import { Stft, clamp, mean, std } from './fft';

export interface TempoResult {
  bpm: number;
  bpmConfidence: number;
  /** seconds; beat positions across the excerpt */
  beats: number[];
  downbeats: number[];
  phraseEnds: number[];
  onsetRate: number;
  beatStrength: number;
  /** the onset novelty curve, for the analyse page */
  novelty: number[];
  noveltyTimes: number[];
  /** tempogram: bpm -> strength, for the analyse page */
  tempogram: { bpm: number; strength: number }[];
}

/** Spectral flux novelty: positive spectral change, log-compressed. */
export function noveltyCurve(s: Stft): { novelty: Float64Array; times: Float64Array } {
  const n = s.magnitude.length;
  const nov = new Float64Array(Math.max(0, n - 1));
  for (let f = 1; f < n; f++) {
    const a = s.magnitude[f];
    const b = s.magnitude[f - 1];
    let acc = 0;
    for (let k = 0; k < a.length; k++) {
      // log compression tracks perceived accent far better than raw magnitude
      const d = Math.log1p(1000 * a[k]) - Math.log1p(1000 * b[k]);
      if (d > 0) acc += d;
    }
    nov[f - 1] = acc;
  }
  // subtract a local mean and half-wave rectify -> emphasises transients
  const w = 16;
  const out = new Float64Array(nov.length);
  for (let i = 0; i < nov.length; i++) {
    let s0 = 0, c = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(nov.length - 1, i + w); j++) { s0 += nov[j]; c++; }
    out[i] = Math.max(0, nov[i] - s0 / Math.max(1, c));
  }
  const times = new Float64Array(out.length);
  for (let i = 0; i < out.length; i++) times[i] = s.times[i + 1];
  return { novelty: out, times };
}

/**
 * Log-normal tempo prior centred at 120 BPM. Autocorrelation is inherently
 * ambiguous by octaves -- 75 and 150 BPM produce near-identical peaks -- and a
 * perceptual prior is the standard, and honest, way to break that tie.
 */
function tempoPrior(bpm: number): number {
  const mu = Math.log(120);
  const sigma = 0.55;
  return Math.exp(-0.5 * ((Math.log(bpm) - mu) / sigma) ** 2);
}

export function estimateTempo(
  s: Stft,
  minBpm = 55,
  maxBpm = 200,
): TempoResult {
  const { novelty, times } = noveltyCurve(s);
  const dt = s.hop / s.sampleRate;
  const N = novelty.length;

  if (N < 32) {
    return {
      bpm: 0, bpmConfidence: 0, beats: [], downbeats: [], phraseEnds: [],
      onsetRate: 0, beatStrength: 0,
      novelty: Array.from(novelty), noveltyTimes: Array.from(times), tempogram: [],
    };
  }

  const minLag = Math.max(2, Math.floor(60 / (maxBpm * dt)));
  const maxLag = Math.min(N - 2, Math.ceil(60 / (minBpm * dt)));

  const m = mean(novelty);
  const centred = new Float64Array(N);
  for (let i = 0; i < N; i++) centred[i] = novelty[i] - m;

  let bestLag = minLag;
  let bestVal = -Infinity;
  const tempogram: { bpm: number; strength: number }[] = [];
  const raw: number[] = [];

  for (let lag = minLag; lag <= maxLag; lag++) {
    let acc = 0;
    for (let i = 0; i + lag < N; i++) acc += centred[i] * centred[i + lag];
    acc /= N - lag;
    const bpm = 60 / (lag * dt);
    const weighted = acc * tempoPrior(bpm);
    raw.push(weighted);
    tempogram.push({ bpm: Number(bpm.toFixed(2)), strength: weighted });
    if (weighted > bestVal) { bestVal = weighted; bestLag = lag; }
  }

  // confidence: how far the winning peak stands above the rest of the surface
  const mu = mean(raw);
  const sd = std(raw);
  const bpmConfidence = clamp(sd > 0 ? (bestVal - mu) / (4 * sd) : 0, 0, 1);
  const period = bestLag * dt;
  const bpm = 60 / period;

  // --- beat phase: slide a pulse train and take the best alignment -----------
  let bestPhase = 0;
  let bestPhaseVal = -Infinity;
  for (let p = 0; p < bestLag; p++) {
    let acc = 0;
    for (let i = p; i < N; i += bestLag) acc += novelty[i];
    if (acc > bestPhaseVal) { bestPhaseVal = acc; bestPhase = p; }
  }

  const beats: number[] = [];
  const beatIdx: number[] = [];
  for (let i = bestPhase; i < N; i += bestLag) {
    beats.push(times[i]);
    beatIdx.push(i);
  }

  // --- downbeat: assume 4/4, pick the strongest of the 4 phase candidates ----
  let bestBarPhase = 0;
  let bestBarVal = -Infinity;
  for (let b = 0; b < 4; b++) {
    let acc = 0;
    for (let k = b; k < beatIdx.length; k += 4) acc += novelty[beatIdx[k]];
    if (acc > bestBarVal) { bestBarVal = acc; bestBarPhase = b; }
  }

  const downbeats: number[] = [];
  for (let k = bestBarPhase; k < beats.length; k += 4) downbeats.push(beats[k]);

  // phrase ends: the last beat before every 4th bar line (a 4-bar phrase)
  const phraseEnds: number[] = [];
  for (let k = bestBarPhase + 15; k < beats.length; k += 16) phraseEnds.push(beats[k]);
  if (phraseEnds.length === 0 && beats.length > 4) {
    for (let k = bestBarPhase + 3; k < beats.length; k += 4) phraseEnds.push(beats[k]);
  }

  // --- descriptive rhythm stats ---------------------------------------------
  const thresh = m + 1.5 * std(novelty);
  let onsets = 0;
  for (let i = 1; i < N - 1; i++) {
    if (novelty[i] > thresh && novelty[i] >= novelty[i - 1] && novelty[i] > novelty[i + 1]) onsets++;
  }
  const durSec = N * dt;
  const onsetRate = durSec > 0 ? onsets / durSec : 0;

  const atBeats = beatIdx.map((i) => novelty[i]);
  const beatStrength = m > 0 ? clamp(mean(atBeats) / (m * 3), 0, 1) : 0;

  return {
    bpm: Number(bpm.toFixed(2)),
    bpmConfidence,
    beats, downbeats, phraseEnds,
    onsetRate: Number(onsetRate.toFixed(3)),
    beatStrength,
    novelty: Array.from(novelty, (x) => Number(x.toFixed(4))),
    noveltyTimes: Array.from(times, (x) => Number(x.toFixed(3))),
    tempogram,
  };
}

/**
 * Turn a beat grid into per-frame weights for the chroma STFT, which runs at a
 * different (much coarser) hop than the onset STFT.
 */
export function structuralWeights(
  chromaTimes: Float64Array,
  t: TempoResult,
): { downbeat: Float64Array; phraseFinal: Float64Array } {
  const downbeat = new Float64Array(chromaTimes.length);
  const phraseFinal = new Float64Array(chromaTimes.length);
  if (!t.bpm || t.beats.length < 2) return { downbeat, phraseFinal };

  const beatPeriod = 60 / t.bpm;
  const sigma = Math.max(0.08, beatPeriod * 0.5);

  const accumulate = (targets: number[], into: Float64Array) => {
    for (let i = 0; i < chromaTimes.length; i++) {
      const ct = chromaTimes[i];
      let w = 0;
      for (const tt of targets) {
        const d = (ct - tt) / sigma;
        if (Math.abs(d) < 3) w += Math.exp(-0.5 * d * d);
      }
      into[i] = w;
    }
  };

  accumulate(t.downbeats, downbeat);
  accumulate(t.phraseEnds, phraseFinal);
  return { downbeat, phraseFinal };
}
