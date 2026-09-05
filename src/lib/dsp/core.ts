/**
 * The CRATE analysis pipeline, end to end.
 *
 *   audio -> two STFTs (coarse for harmony, fine for rhythm)
 *         -> tempo + beat grid
 *         -> structurally weighted HPCP variants
 *         -> joint tonic x mode classification         [the contribution]
 *         -> Krumhansl-Schmuckler baseline on the SAME HPCP   [the control]
 *         -> timbre / dynamics descriptors
 *         -> a 64-dim L2-normalised descriptor vector
 */

import { stft, clamp, logScale } from './fft';

/**
 * Browser-safe half of the analysis pipeline.
 *
 * Nothing in this file touches Node APIs, which is deliberate: the /analyze page
 * decodes audio with the Web Audio API and runs this exact code in the browser.
 * Vercel's serverless runtime has no ffmpeg binary, so server-side live analysis
 * would need a ~78 MB static build bundled into every function. Running it on the
 * client instead costs nothing, scales for free, and proves the pipeline is
 * genuinely portable rather than tied to one host.
 *
 * `analyze.ts` adds the Node-only URL entry point on top of this.
 */
import { estimateTempo, structuralWeights, TempoResult } from './tempo';
import { computeHpcp, toUnitMax } from './hpcp';
import { classifyMode, ModeResult, PITCH_NAMES } from './modes';
import { baselineKey, BaselineResult } from './baseline';
import { spectralDescriptors, dynamics, SpectralDescriptors, Dynamics } from './spectral';

export const ANALYZER_VERSION = 'crate-dsp/1.1.0';
export const SAMPLE_RATE = 22050;
export const EXCERPT_SECONDS = 60;

/** Coarse STFT: 2.7 Hz bins at 22.05 kHz — enough resolution to place a bass note. */
export const CHROMA_FRAME = 8192;
export const CHROMA_HOP = 2048;
/** Fine STFT: 11.6 ms hop — enough resolution to place a transient. */
export const ONSET_FRAME = 1024;
export const ONSET_HOP = 256;

export interface AnalysisResult {
  analyzerVersion: string;
  sampleRate: number;
  excerptOffsetSec: number;
  excerptSeconds: number;
  durationSec: number | null;

  tempo: TempoResult;
  mode: ModeResult;
  baseline: BaselineResult;
  spectral: SpectralDescriptors;
  dynamics: Dynamics;

  hpcp: number[];
  hpcpBass: number[];
  hpcpDownbeat: number[];
  hpcpPhraseFinal: number[];
  /** per-frame chroma, decimated for display */
  chromagram: number[][];

  energy: number;
  brightness: number;
  instrumentalLikelihood: number;
  descriptorVector: number[];   // 64-dim, L2-normalised

  timings: Record<string, number>;
}

function buildDescriptorVector(
  hpcp: number[], hpcpBass: number[], sp: SpectralDescriptors, dy: Dynamics,
  tempo: TempoResult, energy: number, brightness: number,
): number[] {
  const v: number[] = [];
  v.push(...hpcp);                                   // 12
  v.push(...hpcpBass);                               // 12
  v.push(...sp.mfcc.map((x) => Math.tanh(x / 8)));   // 26
  v.push(
    clamp(tempo.bpm / 200, 0, 1),
    tempo.bpmConfidence,
    energy,
    brightness,
    clamp((dy.loudnessDb + 45) / 45, 0, 1),
    logScale(dy.crestFactor, 20),
    clamp(dy.dynamicRangeDb / 40, 0, 1),
    logScale(sp.spectralCentroid, 6000),
    logScale(sp.spectralRolloff, 10000),
    clamp(sp.spectralFlatness * 6, 0, 1),
    logScale(sp.spectralBandwidth, 5000),
    clamp(dy.zcr / 5, 0, 1),
    sp.hfRatio,
    sp.lfRatio,
  );                                                 // 14  => 64 total

  if (v.length !== 64) throw new Error(`descriptor vector must be 64-dim, got ${v.length}`);
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map((x) => Number((x / n).toFixed(6)));
}

/** The pure part: PCM in, features out. Exercised directly by the unit tests. */
export function analyzePcm(
  x: Float64Array,
  sampleRate = SAMPLE_RATE,
): Omit<AnalysisResult, 'durationSec' | 'excerptOffsetSec' | 'excerptSeconds'> {
  const tA = Date.now();
  const chroma = stft(x, sampleRate, CHROMA_FRAME, CHROMA_HOP);
  const onset = stft(x, sampleRate, ONSET_FRAME, ONSET_HOP);
  const tStft = Date.now();

  const tempo = estimateTempo(onset);
  const tTempo = Date.now();

  const weights = structuralWeights(chroma.times, tempo);
  const bundle = computeHpcp(chroma, weights);
  const tHpcp = Date.now();

  const hpcp = toUnitMax(bundle.hpcp);
  const hpcpBass = toUnitMax(bundle.hpcpBass);
  const hpcpDownbeat = toUnitMax(bundle.hpcpDownbeat);
  const hpcpPhraseFinal = toUnitMax(bundle.hpcpPhraseFinal);

  const mode = classifyMode({
    hpcp: bundle.hpcp,
    hpcpBass: bundle.hpcpBass,
    hpcpDownbeat: bundle.hpcpDownbeat,
    hpcpPhraseFinal: bundle.hpcpPhraseFinal,
  });
  // the control condition sees exactly the same profile
  const baseline = baselineKey(bundle.hpcp, 'krumhansl');
  const tMode = Date.now();

  const spectral = spectralDescriptors(chroma, onset);
  const dyn = dynamics(x, sampleRate);
  const tSpec = Date.now();

  // Brightness maps the spectral centroid onto [0,1] LINEARLY IN LOG FREQUENCY,
  // between 150 Hz and 5 kHz. An earlier log1p curve was measured on the corpus
  // and found to squash every real track into 0.86-0.99, which made "dark" match
  // nothing at all -- pitch perception is logarithmic, so the mapping must be too.
  const brightness = clamp(
    (Math.log2(Math.max(80, spectral.spectralCentroid)) - Math.log2(150)) /
      (Math.log2(5000) - Math.log2(150)),
    0, 1,
  );
  const energy = clamp(
    0.40 * clamp((dyn.loudnessDb + 32) / 26, 0, 1) +
    0.30 * spectral.percussiveRatio +
    0.30 * clamp(tempo.onsetRate / 7, 0, 1),
    0, 1,
  );

  // documented heuristic — see spectral.ts, and the README's limitations section
  const vocalCue = clamp(
    0.55 * clamp(spectral.syllabicModulation / 0.35, 0, 1) +
    0.25 * clamp((spectral.midRatio - 0.25) / 0.45, 0, 1) +
    0.20 * spectral.centroidVariability,
    0, 1,
  );
  const instrumentalLikelihood = Number(clamp(1 - vocalCue, 0, 1).toFixed(4));

  // decimate the chromagram to at most 200 columns for display
  const step = Math.max(1, Math.ceil(bundle.frames.length / 200));
  const chromagram: number[][] = [];
  for (let i = 0; i < bundle.frames.length; i += step) {
    chromagram.push(Array.from(bundle.frames[i], (v) => Number(v.toFixed(3))));
  }

  return {
    analyzerVersion: ANALYZER_VERSION,
    sampleRate,
    tempo, mode, baseline, spectral, dynamics: dyn,
    hpcp, hpcpBass, hpcpDownbeat, hpcpPhraseFinal, chromagram,
    energy: Number(energy.toFixed(4)),
    brightness: Number(brightness.toFixed(4)),
    instrumentalLikelihood,
    descriptorVector: buildDescriptorVector(hpcp, hpcpBass, spectral, dyn, tempo, energy, brightness),
    timings: {
      stftMs: tStft - tA, tempoMs: tTempo - tStft, hpcpMs: tHpcp - tTempo,
      modeMs: tMode - tHpcp, spectralMs: tSpec - tMode,
    },
  };
}

export { PITCH_NAMES };
