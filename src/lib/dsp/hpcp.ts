/**
 * Harmonic Pitch Class Profile (Gomez, 2006), with the three structurally
 * weighted variants the mode classifier needs.
 *
 * A plain chroma vector answers "which pitch classes are present". That is not
 * enough to find a tonal centre, because every rotation of a diatonic set has
 * identical content. These variants answer "which pitch classes are STRUCTURALLY
 * EMPHASISED", which is the question that actually separates E Phrygian from
 * C major:
 *
 *   hpcp          - the whole excerpt, harmonically summed
 *   hpcpBass      - fundamentals below ~250 Hz only. A bassline sitting on E is
 *                   the single strongest cue that E is the tonic.
 *   hpcpDownbeat  - frames near bar-one, where harmonic function is stated
 *   hpcpPhraseFinal - frames in the last beat of each bar group, where phrases
 *                   resolve onto the tonic
 */

import { Stft, clamp } from './fft';

export const A4 = 440;

/** Continuous pitch class of a frequency: 0 = C, fractional part = detuning. */
export function pitchClassOf(freq: number): number {
  const midi = 69 + 12 * Math.log2(freq / A4);
  return ((midi % 12) + 12) % 12;
}

export interface HpcpOptions {
  /** frequency band considered, Hz */
  fMin: number;
  fMax: number;
  /** how many harmonics each peak is allowed to be, for harmonic summation */
  harmonics: number;
  /** decay per harmonic index */
  harmonicDecay: number;
  /** half-width of the contribution window, in semitones */
  windowSemitones: number;
  /** peaks below this fraction of the frame maximum are ignored */
  peakThreshold: number;
}

export const DEFAULT_HPCP: HpcpOptions = {
  fMin: 40,
  fMax: 5000,
  harmonics: 8,
  harmonicDecay: 0.6,
  windowSemitones: 1.0,
  peakThreshold: 0.06,
};

/**
 * Per-frame HPCP. Each local spectral peak contributes energy not only to its own
 * pitch class but to the pitch classes it could be a harmonic OF, with geometric
 * decay -- this is what stops a bright timbre's upper partials from inventing
 * pitch classes that are not being played.
 */
export function frameHpcp(
  mag: Float64Array,
  freqs: Float64Array,
  opt: HpcpOptions = DEFAULT_HPCP,
): Float64Array {
  const out = new Float64Array(12);
  let maxMag = 0;
  for (let b = 1; b < mag.length - 1; b++) if (mag[b] > maxMag) maxMag = mag[b];
  if (maxMag <= 0) return out;
  const thresh = maxMag * opt.peakThreshold;

  for (let b = 1; b < mag.length - 1; b++) {
    const m = mag[b];
    if (m < thresh) continue;
    if (m < mag[b - 1] || m < mag[b + 1]) continue; // local maximum only

    // parabolic interpolation for sub-bin frequency accuracy
    const a0 = mag[b - 1], a1 = mag[b], a2 = mag[b + 1];
    const denom = a0 - 2 * a1 + a2;
    const delta = denom === 0 ? 0 : (0.5 * (a0 - a2)) / denom;
    const df = freqs[1] - freqs[0];
    const f = freqs[b] + clamp(delta, -0.5, 0.5) * df;
    if (f < opt.fMin || f > opt.fMax) continue;

    const energy = m * m;
    for (let h = 1; h <= opt.harmonics; h++) {
      const fundamental = f / h;
      if (fundamental < opt.fMin) break;
      const w = Math.pow(opt.harmonicDecay, h - 1);
      const pc = pitchClassOf(fundamental);
      // cos^2 spread across the two nearest pitch class bins
      for (let k = -1; k <= 1; k++) {
        const bin = ((Math.round(pc) + k) % 12 + 12) % 12;
        let d = pc - (Math.round(pc) + k);
        if (d > 6) d -= 12;
        if (d < -6) d += 12;
        const ad = Math.abs(d);
        if (ad > opt.windowSemitones) continue;
        const shape = Math.cos((Math.PI / 2) * (ad / opt.windowSemitones)) ** 2;
        out[bin] += energy * w * shape;
      }
    }
  }
  // per-frame max normalisation: a loud frame should not outvote a quiet one
  let mx = 0;
  for (let i = 0; i < 12; i++) if (out[i] > mx) mx = out[i];
  if (mx > 0) for (let i = 0; i < 12; i++) out[i] /= mx;
  return out;
}

export interface HpcpBundle {
  hpcp: Float64Array;
  hpcpBass: Float64Array;
  hpcpDownbeat: Float64Array;
  hpcpPhraseFinal: Float64Array;
  /** per-frame profiles, kept for the analyse page's chromagram */
  frames: Float64Array[];
}

export interface StructuralWeights {
  /** weight per frame for downbeat emphasis */
  downbeat: Float64Array;
  /** weight per frame for phrase-final emphasis */
  phraseFinal: Float64Array;
}

export function computeHpcp(
  s: Stft,
  weights: StructuralWeights | null,
  opt: HpcpOptions = DEFAULT_HPCP,
): HpcpBundle {
  const bassOpt: HpcpOptions = { ...opt, fMax: 250, harmonics: 3 };
  const hpcp = new Float64Array(12);
  const hpcpBass = new Float64Array(12);
  const hpcpDownbeat = new Float64Array(12);
  const hpcpPhraseFinal = new Float64Array(12);
  const frames: Float64Array[] = [];

  for (let f = 0; f < s.magnitude.length; f++) {
    const p = frameHpcp(s.magnitude[f], s.freqs, opt);
    frames.push(p);
    const pb = frameHpcp(s.magnitude[f], s.freqs, bassOpt);
    const wd = weights ? weights.downbeat[f] ?? 0 : 0;
    const wp = weights ? weights.phraseFinal[f] ?? 0 : 0;
    for (let i = 0; i < 12; i++) {
      hpcp[i] += p[i];
      hpcpBass[i] += pb[i];
      hpcpDownbeat[i] += p[i] * wd;
      hpcpPhraseFinal[i] += p[i] * wp;
    }
  }

  // if no beat grid was available, structural variants fall back to the global
  // profile rather than silently contributing zeros to the tonic prior
  const sum = (v: Float64Array) => v.reduce((a, b) => a + b, 0);
  if (sum(hpcpDownbeat) <= 0) hpcpDownbeat.set(hpcp);
  if (sum(hpcpPhraseFinal) <= 0) hpcpPhraseFinal.set(hpcp);
  if (sum(hpcpBass) <= 0) hpcpBass.set(hpcp);

  return { hpcp, hpcpBass, hpcpDownbeat, hpcpPhraseFinal, frames };
}

export function toUnitMax(v: Float64Array): number[] {
  let m = 0;
  for (let i = 0; i < v.length; i++) if (v[i] > m) m = v[i];
  return Array.from(v, (x) => (m > 0 ? Number((x / m).toFixed(5)) : 0));
}
