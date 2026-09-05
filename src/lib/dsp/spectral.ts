/**
 * Timbre, dynamics and texture descriptors.
 *
 * These do not identify the tonal centre -- that is modes.ts -- they describe
 * what the track SOUNDS like, and they are what the semantic half of retrieval
 * ("hazy", "cavernous", "warm tape saturation") is ultimately grounded in.
 */

import { Stft, fft, mean, std, clamp } from './fft';

// ---------------------------------------------------------------------------
// mel scale
// ---------------------------------------------------------------------------
const hzToMel = (f: number) => 2595 * Math.log10(1 + f / 700);
const melToHz = (m: number) => 700 * (10 ** (m / 2595) - 1);

export function melFilterbank(
  nFilters: number,
  freqs: Float64Array,
  fMin = 30,
  fMax = 8000,
): Float64Array[] {
  const lo = hzToMel(fMin);
  const hi = hzToMel(Math.min(fMax, freqs[freqs.length - 1]));
  const pts = new Float64Array(nFilters + 2);
  for (let i = 0; i < pts.length; i++) pts[i] = melToHz(lo + ((hi - lo) * i) / (nFilters + 1));

  const bank: Float64Array[] = [];
  for (let i = 0; i < nFilters; i++) {
    const f = new Float64Array(freqs.length);
    const [a, b, c] = [pts[i], pts[i + 1], pts[i + 2]];
    for (let k = 0; k < freqs.length; k++) {
      const x = freqs[k];
      if (x >= a && x <= b) f[k] = b === a ? 1 : (x - a) / (b - a);
      else if (x > b && x <= c) f[k] = c === b ? 1 : (c - x) / (c - b);
    }
    bank.push(f);
  }
  return bank;
}

export function melSpectrogram(s: Stft, nFilters = 64): { bands: Float64Array[]; centers: number[] } {
  const bank = melFilterbank(nFilters, s.freqs);
  const bands: Float64Array[] = [];
  for (const f of s.magnitude) {
    const row = new Float64Array(nFilters);
    for (let i = 0; i < nFilters; i++) {
      let acc = 0;
      const filt = bank[i];
      for (let k = 0; k < f.length; k++) if (filt[k] > 0) acc += f[k] * filt[k];
      row[i] = acc;
    }
    bands.push(row);
  }
  // approximate centre frequency of each band, for banding queries
  const lo = hzToMel(30), hi = hzToMel(Math.min(8000, s.freqs[s.freqs.length - 1]));
  const centers = Array.from({ length: nFilters }, (_, i) =>
    melToHz(lo + ((hi - lo) * (i + 1)) / (nFilters + 1)));
  return { bands, centers };
}

/** DCT-II, orthonormal-ish; used for MFCC. */
export function dct2(x: Float64Array, nOut: number): Float64Array {
  const N = x.length;
  const out = new Float64Array(nOut);
  for (let k = 0; k < nOut; k++) {
    let acc = 0;
    for (let n = 0; n < N; n++) acc += x[n] * Math.cos((Math.PI / N) * (n + 0.5) * k);
    out[k] = acc * Math.sqrt(2 / N);
  }
  return out;
}

// ---------------------------------------------------------------------------
// descriptors
// ---------------------------------------------------------------------------
export interface SpectralDescriptors {
  spectralCentroid: number;
  spectralRolloff: number;
  spectralFlatness: number;
  spectralBandwidth: number;
  spectralFlux: number;
  hfRatio: number;
  lfRatio: number;
  midRatio: number;
  mfcc: number[];          // 13 mean + 13 std
  percussiveRatio: number;
  syllabicModulation: number;
  centroidVariability: number;
}

/** 1-D median filter, window must be odd. */
function medianFilter(v: Float64Array, w: number): Float64Array {
  const h = (w - 1) >> 1;
  const out = new Float64Array(v.length);
  const buf: number[] = [];
  for (let i = 0; i < v.length; i++) {
    buf.length = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(v.length - 1, i + h); j++) buf.push(v[j]);
    buf.sort((a, b) => a - b);
    out[i] = buf[(buf.length - 1) >> 1];
  }
  return out;
}

/**
 * Harmonic/percussive ratio via median-filter separation (Fitzgerald 2010),
 * run on a 64-band mel spectrogram rather than the raw STFT so it stays cheap
 * enough to run across a whole corpus.
 *
 * Sustained content is smooth along TIME; transient content is smooth along
 * FREQUENCY. Median filtering each axis and comparing the two gives a usable
 * "how percussive is this" scalar without a source separation model.
 */
function harmonicPercussive(bands: Float64Array[]): number {
  const nF = bands.length;
  if (nF < 8) return 0.5;
  const nB = bands[0].length;

  // smooth along time -> harmonic estimate
  const H: Float64Array[] = Array.from({ length: nF }, () => new Float64Array(nB));
  for (let b = 0; b < nB; b++) {
    const col = new Float64Array(nF);
    for (let f = 0; f < nF; f++) col[f] = bands[f][b];
    const sm = medianFilter(col, 17);
    for (let f = 0; f < nF; f++) H[f][b] = sm[f];
  }
  // smooth along frequency -> percussive estimate
  const P: Float64Array[] = bands.map((row) => medianFilter(row, 9));

  let hE = 0, pE = 0;
  for (let f = 0; f < nF; f++) {
    for (let b = 0; b < nB; b++) {
      const h = H[f][b] ** 2;
      const p = P[f][b] ** 2;
      hE += h; pE += p;
    }
  }
  return pE + hE > 0 ? pE / (pE + hE) : 0.5;
}

/**
 * Energy modulation in the 3-8 Hz band of the mid-frequency envelope.
 *
 * Speech and sung vocals modulate amplitude at the syllabic rate, roughly 4 Hz
 * (Scheirer & Slaney 1997). This is the single most usable vocal cue available
 * without a trained model.
 *
 * CAVEAT, stated here because it also belongs in the README: in dance music a
 * snare on every backbeat at 120 BPM lands at 1 Hz and its 16th-note ghosting
 * lands near 8 Hz, both inside the mid band. This feature is therefore the
 * WEAKEST link in the feature set, and the "no vocals" hard constraint is only
 * ever as good as it is.
 */
function syllabicModulation(bands: Float64Array[], centers: number[], envRate: number): number {
  const idx: number[] = [];
  for (let i = 0; i < centers.length; i++) if (centers[i] >= 300 && centers[i] <= 3000) idx.push(i);
  if (!idx.length || bands.length < 64) return 0;

  const n = 1 << Math.floor(Math.log2(bands.length));
  const env = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    let acc = 0;
    for (const b of idx) acc += bands[f][b];
    env[f] = acc;
  }
  const m = mean(env);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = (env[i] - m) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  fft(re, im);

  let inBand = 0, total = 0;
  for (let k = 1; k < n / 2; k++) {
    const hz = (k * envRate) / n;
    const p = re[k] * re[k] + im[k] * im[k];
    total += p;
    if (hz >= 3 && hz <= 8) inBand += p;
  }
  return total > 0 ? clamp(inBand / total, 0, 1) : 0;
}

export function spectralDescriptors(
  chroma: Stft,
  onset: Stft,
): SpectralDescriptors {
  const cents: number[] = [];
  const rolls: number[] = [];
  const flats: number[] = [];
  const bws: number[] = [];
  let hfE = 0, lfE = 0, midE = 0, allE = 0;
  let flux = 0;

  for (let f = 0; f < chroma.magnitude.length; f++) {
    const mag = chroma.magnitude[f];
    let sum = 0, wsum = 0, logsum = 0, nz = 0;
    for (let b = 1; b < mag.length; b++) {
      const m = mag[b];
      sum += m;
      wsum += m * chroma.freqs[b];
      if (m > 1e-12) { logsum += Math.log(m); nz++; }
      const e = m * m;
      allE += e;
      if (chroma.freqs[b] > 4000) hfE += e;
      else if (chroma.freqs[b] < 250) lfE += e;
      if (chroma.freqs[b] >= 250 && chroma.freqs[b] <= 4000) midE += e;
    }
    if (sum <= 0) continue;
    const c = wsum / sum;
    cents.push(c);

    let acc = 0, roll = 0;
    const target = 0.85 * sum;
    for (let b = 1; b < mag.length; b++) { acc += mag[b]; if (acc >= target) { roll = chroma.freqs[b]; break; } }
    rolls.push(roll);

    const am = sum / (mag.length - 1);
    const gm = nz > 0 ? Math.exp(logsum / nz) : 0;
    flats.push(am > 0 ? gm / am : 0);

    let sp = 0;
    for (let b = 1; b < mag.length; b++) sp += mag[b] * (chroma.freqs[b] - c) ** 2;
    bws.push(Math.sqrt(sp / sum));

    if (f > 0) {
      const prev = chroma.magnitude[f - 1];
      let d = 0;
      for (let b = 1; b < mag.length; b++) { const x = mag[b] - prev[b]; if (x > 0) d += x; }
      flux += d;
    }
  }

  const { bands, centers } = melSpectrogram(onset, 64);
  const envRate = onset.sampleRate / onset.hop;

  const mfccFrames: Float64Array[] = [];
  for (const row of bands) {
    const logged = new Float64Array(row.length);
    for (let i = 0; i < row.length; i++) logged[i] = Math.log(row[i] + 1e-10);
    mfccFrames.push(dct2(logged, 13));
  }
  const mfccMean: number[] = [];
  const mfccStd: number[] = [];
  for (let k = 0; k < 13; k++) {
    const col = mfccFrames.map((f) => f[k]);
    mfccMean.push(Number(mean(col).toFixed(4)));
    mfccStd.push(Number(std(col).toFixed(4)));
  }

  const nyq = chroma.sampleRate / 2;
  return {
    spectralCentroid: Number(mean(cents).toFixed(2)),
    spectralRolloff: Number(mean(rolls).toFixed(2)),
    spectralFlatness: Number(mean(flats).toFixed(5)),
    spectralBandwidth: Number(mean(bws).toFixed(2)),
    spectralFlux: Number((flux / Math.max(1, chroma.magnitude.length)).toFixed(4)),
    hfRatio: allE > 0 ? Number((hfE / allE).toFixed(5)) : 0,
    lfRatio: allE > 0 ? Number((lfE / allE).toFixed(5)) : 0,
    midRatio: allE > 0 ? Number((midE / allE).toFixed(5)) : 0,
    mfcc: [...mfccMean, ...mfccStd],
    percussiveRatio: Number(harmonicPercussive(bands).toFixed(4)),
    syllabicModulation: Number(syllabicModulation(bands, centers, envRate).toFixed(4)),
    centroidVariability: cents.length ? Number(clamp(std(cents) / (0.35 * nyq), 0, 1).toFixed(4)) : 0,
  };
}

export interface Dynamics {
  rms: number;
  loudnessDb: number;
  crestFactor: number;
  dynamicRangeDb: number;
  zcr: number;
}

export function dynamics(x: Float64Array, sampleRate: number): Dynamics {
  let sum = 0, peak = 0, crossings = 0;
  for (let i = 0; i < x.length; i++) {
    sum += x[i] * x[i];
    const a = Math.abs(x[i]);
    if (a > peak) peak = a;
    if (i > 0 && ((x[i - 1] < 0 && x[i] >= 0) || (x[i - 1] >= 0 && x[i] < 0))) crossings++;
  }
  const rms = Math.sqrt(sum / Math.max(1, x.length));

  // frame-wise RMS distribution -> dynamic range as p95/p10
  const fs = Math.floor(sampleRate * 0.05);
  const frames: number[] = [];
  for (let i = 0; i + fs <= x.length; i += fs) {
    let s = 0;
    for (let j = 0; j < fs; j++) s += x[i + j] * x[i + j];
    frames.push(Math.sqrt(s / fs));
  }
  frames.sort((a, b) => a - b);
  const q = (p: number) => frames.length ? frames[clamp(Math.floor(p * frames.length), 0, frames.length - 1)] : 0;
  const p95 = q(0.95), p10 = q(0.10);

  return {
    rms: Number(rms.toFixed(6)),
    loudnessDb: Number((20 * Math.log10(rms + 1e-9)).toFixed(2)),
    crestFactor: Number((peak / (rms + 1e-9)).toFixed(3)),
    dynamicRangeDb: Number((20 * Math.log10((p95 + 1e-9) / (p10 + 1e-9))).toFixed(2)),
    zcr: Number((crossings / Math.max(1, x.length / sampleRate) / 1000).toFixed(4)),
  };
}
