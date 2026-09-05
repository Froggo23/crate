/**
 * Minimal DSP primitives. No external libraries: every transform CRATE relies on
 * is implemented here so the analysis chain is auditable end to end.
 */

/** In-place iterative radix-2 Cooley-Tukey FFT. `re`/`im` length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n !== im.length || (n & (n - 1)) !== 0) {
    throw new Error(`fft: length must be a power of two (got ${n})`);
  }
  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  // butterflies
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + half] * curRe - im[i + k + half] * curIm;
        const vIm = re[i + k + half] * curIm + im[i + k + half] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + half] = uRe - vRe;
        im[i + k + half] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/** Periodic Hann window (correct choice for STFT analysis/overlap-add). */
export function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  return w;
}

export interface Stft {
  /** magnitude[frame][bin], bin count = frameSize/2 + 1 */
  magnitude: Float64Array[];
  frameSize: number;
  hop: number;
  sampleRate: number;
  /** centre frequency of each bin, Hz */
  freqs: Float64Array;
  /** time in seconds at the centre of each frame */
  times: Float64Array;
}

/** Short-time Fourier transform magnitude. */
export function stft(
  x: Float64Array,
  sampleRate: number,
  frameSize: number,
  hop: number,
): Stft {
  const win = hann(frameSize);
  const bins = frameSize / 2 + 1;
  const nFrames = Math.max(0, Math.floor((x.length - frameSize) / hop) + 1);
  const magnitude: Float64Array[] = new Array(nFrames);
  const times = new Float64Array(nFrames);

  const re = new Float64Array(frameSize);
  const im = new Float64Array(frameSize);

  for (let f = 0; f < nFrames; f++) {
    const off = f * hop;
    for (let i = 0; i < frameSize; i++) {
      re[i] = x[off + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    const mag = new Float64Array(bins);
    for (let b = 0; b < bins; b++) mag[b] = Math.hypot(re[b], im[b]);
    magnitude[f] = mag;
    times[f] = (off + frameSize / 2) / sampleRate;
  }

  const freqs = new Float64Array(bins);
  for (let b = 0; b < bins; b++) freqs[b] = (b * sampleRate) / frameSize;

  return { magnitude, frameSize, hop, sampleRate, freqs, times };
}

/** Pearson correlation. Returns 0 when either vector is constant. */
export function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den < 1e-12 ? 0 : num / den;
}

/** Scale a vector so its maximum is 1. Zero vectors pass through unchanged. */
export function normMax(v: Float64Array): Float64Array {
  let m = 0;
  for (let i = 0; i < v.length; i++) if (v[i] > m) m = v[i];
  if (m <= 0) return v;
  const out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / m;
  return out;
}

/** L2-normalise in place-safe fashion. */
export function l2norm(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  return n < 1e-12 ? v.slice() : v.map((x) => x / n);
}

export function mean(v: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i];
  return v.length ? s / v.length : 0;
}

export function std(v: ArrayLike<number>): number {
  const m = mean(v);
  let s = 0;
  for (let i = 0; i < v.length; i++) s += (v[i] - m) ** 2;
  return v.length ? Math.sqrt(s / v.length) : 0;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Map an unbounded positive quantity into [0,1] with a soft log knee. */
export function logScale(x: number, knee: number): number {
  return clamp(Math.log1p(Math.max(0, x)) / Math.log1p(knee), 0, 1);
}
