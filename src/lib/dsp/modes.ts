/**
 * CRATE's core contribution (project plan section 2.1): modal, scale-aware key
 * detection.
 *
 * Standard key detection outputs a tonic plus a binary major/minor mode. Every
 * mainstream tool works this way. But a large share of electronic, film and
 * non-Western music is modal, and a track in E Phrygian shares its exact pitch
 * class content with C major and A minor. A pitch-class histogram alone cannot
 * separate them -- all three are the same seven notes.
 *
 * What separates them is which note is the TONAL CENTRE. So this module does not
 * pick a tonic and then a mode; it searches the joint (tonic x mode) space and
 * scores each hypothesis with three independent kinds of evidence:
 *
 *   1. TEMPLATE FIT       - correlation of the tonic-rotated HPCP against a
 *                           weighted scale-degree template.
 *   2. TONIC PRIOR        - structural emphasis, not raw duration: bass-register
 *                           energy, downbeat occurrence, phrase-final position.
 *   3. CHARACTERISTIC-DEGREE EVIDENCE
 *                         - a direct contrast between the one degree that
 *                           distinguishes a mode from its nearest neighbour and
 *                           the degree that neighbour has instead. For Phrygian
 *                           this is exactly the plan's diagnostic tell: a flat
 *                           second above a strongly emphasised tonic.
 *
 * When the three disagree, or when no hypothesis fits well, the classifier
 * ABSTAINS ("unclear") rather than guessing. Section 7 of the plan is explicit
 * that an honest abstention is a better result than a confident wrong label.
 */

import { pearson, clamp, normMax } from './fft';

export const PITCH_NAMES = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
] as const;

export type ModeName =
  | 'ionian' | 'dorian' | 'phrygian' | 'lydian' | 'mixolydian' | 'aeolian'
  | 'locrian' | 'harmonic_minor' | 'phrygian_dominant' | 'whole_tone';

export type ModeOrUnclear = ModeName | 'unclear';

export interface ModeTemplate {
  name: ModeName;
  display: string;
  /** semitone offsets from the tonic that belong to the scale */
  degrees: number[];
  /** degrees that distinguish this mode from its nearest neighbour */
  characteristic: number[];
  /** what that neighbour has instead, index-aligned with `characteristic` */
  contrast: number[];
  /** the mode a major/minor-only detector would collapse this into */
  collapsesTo: 'major' | 'minor';
  /**
   * Semitones from the parent major scale's root to this mode's tonic.
   * E Phrygian has parentOffset 4 because it is the third degree of C major --
   * which is exactly why a major/minor detector answers "C major".
   * null for modes with no diatonic parent.
   */
  parentOffset: number | null;
  blurb: string;
}

export const MODE_TEMPLATES: ModeTemplate[] = [
  { name: 'ionian',            display: 'Ionian (major)',     degrees: [0, 2, 4, 5, 7, 9, 11], characteristic: [11, 4], contrast: [10, 3], collapsesTo: 'major', parentOffset: 0, blurb: 'Major. Natural 7th is the tell against Mixolydian.' },
  { name: 'dorian',            display: 'Dorian',             degrees: [0, 2, 3, 5, 7, 9, 10], characteristic: [9],     contrast: [8],     collapsesTo: 'minor', parentOffset: 2, blurb: 'Minor with a natural 6th — the tell against Aeolian.' },
  { name: 'phrygian',          display: 'Phrygian',           degrees: [0, 1, 3, 5, 7, 8, 10], characteristic: [1],     contrast: [2],     collapsesTo: 'minor', parentOffset: 4, blurb: 'Minor with a flat 2nd. The flat 2 above an emphasised tonic is the diagnostic.' },
  { name: 'lydian',            display: 'Lydian',             degrees: [0, 2, 4, 6, 7, 9, 11], characteristic: [6],     contrast: [5],     collapsesTo: 'major', parentOffset: 5, blurb: 'Major with a raised 4th — the tell against Ionian.' },
  { name: 'mixolydian',        display: 'Mixolydian',         degrees: [0, 2, 4, 5, 7, 9, 10], characteristic: [10, 4], contrast: [11, 3], collapsesTo: 'major', parentOffset: 7, blurb: 'Major with a flat 7th.' },
  { name: 'aeolian',           display: 'Aeolian (natural minor)', degrees: [0, 2, 3, 5, 7, 8, 10], characteristic: [8, 2], contrast: [9, 1], collapsesTo: 'minor', parentOffset: 9, blurb: 'Natural minor. Flat 6 against Dorian, natural 2 against Phrygian.' },
  { name: 'locrian',           display: 'Locrian',            degrees: [0, 1, 3, 5, 6, 8, 10], characteristic: [6],     contrast: [7],     collapsesTo: 'minor', parentOffset: 11, blurb: 'Diminished 5th. Rare as a tonal centre; treated with suspicion.' },
  { name: 'harmonic_minor',    display: 'Harmonic minor',     degrees: [0, 2, 3, 5, 7, 8, 11], characteristic: [11, 3], contrast: [10, 4], collapsesTo: 'minor', parentOffset: null, blurb: 'Minor with a raised leading tone.' },
  { name: 'phrygian_dominant', display: 'Phrygian dominant',  degrees: [0, 1, 4, 5, 7, 8, 10], characteristic: [1, 4],  contrast: [2, 3],  collapsesTo: 'minor', parentOffset: null, blurb: 'Flat 2 with a major 3rd. The "Hijaz" colour.' },
  { name: 'whole_tone',        display: 'Whole tone',         degrees: [0, 2, 4, 6, 8, 10],    characteristic: [6, 8],  contrast: [5, 7],  collapsesTo: 'major', parentOffset: null, blurb: 'Symmetric, no perfect 5th, no tonal gravity.' },
];

// --- tunable constants, all in one place so the eval harness can sweep them ---
export const PARAMS = {
  /** weight of the structural tonic prior relative to raw template correlation */
  TONIC_PRIOR_WEIGHT: 0.34,
  /** weight of characteristic-degree contrast evidence */
  DIAGNOSTIC_WEIGHT: 0.22,
  /** weight of scale-membership evidence (coverage minus intrusion) */
  COVERAGE_WEIGHT: 0.25,
  /** contrast evidence is discounted when both degrees carry little energy */
  DIAGNOSTIC_RELIABILITY_SCALE: 0.35,
  /** correlation margin at which mode confidence saturates */
  MARGIN_FULL: 0.18,
  /** correlation floor below which nothing fits well enough to matter */
  FIT_FLOOR: 0.22,
  /** correlation at which fit quality saturates */
  FIT_CEIL: 0.68,
  /** below this confidence the classifier abstains */
  ABSTAIN: 0.34,
  /**
   * Normalised-entropy window, CALIBRATED ON REAL AUDIO, not on synthetic tones.
   *
   * The first values here (0.03 / 0.18) were read off a sustained pure triad,
   * which measures 0.28. That was wrong: a real mix carries drums, noise and
   * reverb, which spread energy across all twelve pitch classes even when the
   * harmony is completely unambiguous. Measured over the ingested corpus the
   * distribution is p10 0.007, p50 0.043, p75 0.092, p90 0.190 -- so a ceiling
   * of 0.18 sat above the 90th percentile and was suppressing the confidence of
   * most genuinely tonal tracks.
   *
   * The floor is anchored just above measured white noise (0.005); the ceiling
   * sits at the corpus p75, where material is reliably tonal. These remain
   * provisional: the defensible calibration is against the hand-labelled set,
   * and `scripts/reclassify.ts` exists so that sweep costs seconds.
   */
  CLARITY_FLOOR: 0.015,
  CLARITY_CEIL: 0.09,
  /** Locrian is vanishingly rare as an actual tonal centre; damp it */
  LOCRIAN_PENALTY: 0.10,
  /** weight of tonic-chord quality evidence when a chord histogram is available */
  CHORD_QUALITY_WEIGHT: 0.16,
  /** contributions to the structural tonic prior */
  PRIOR_BASS: 0.42,
  PRIOR_DOWNBEAT: 0.24,
  PRIOR_PHRASE_FINAL: 0.14,
  PRIOR_GLOBAL: 0.20,
};

/**
 * Scale-degree weights. Tonic and dominant carry tonal function and are weighted
 * accordingly; the mode's characteristic degree is boosted so that neighbouring
 * modes (which differ by a single note) stay separable under correlation.
 */
function templateVector(t: ModeTemplate): Float64Array {
  const v = new Float64Array(12).fill(0.28); // non-scale tones: present but unexpected
  for (const d of t.degrees) {
    let w = 2.0;
    if (d === 0) w = 6.0;                    // tonic
    else if (d === 7) w = 4.0;               // perfect fifth
    else if (d === 3 || d === 4) w = 3.4;    // the third defines colour
    v[d % 12] = w;
  }
  for (const d of t.characteristic) v[d % 12] *= 1.55;
  return v;
}

const TEMPLATE_VECTORS: Record<ModeName, Float64Array> = Object.fromEntries(
  MODE_TEMPLATES.map((t) => [t.name, templateVector(t)]),
) as Record<ModeName, Float64Array>;

export function rotateToTonic(hpcp: ArrayLike<number>, tonic: number): Float64Array {
  const out = new Float64Array(12);
  for (let d = 0; d < 12; d++) out[d] = hpcp[(tonic + d) % 12];
  return out;
}

/**
 * Contrast between a mode's characteristic degree and the degree its nearest
 * neighbour has instead, in [-1, 1]. Positive means the evidence favours this
 * mode over that neighbour.
 *
 * For Phrygian at tonic t this reduces to exactly the plan's rule: compare the
 * energy on the flat 2 against the energy on the natural 2.
 */
export function characteristicEvidence(
  rotated: Float64Array,
  t: ModeTemplate,
): number {
  let acc = 0;
  for (let i = 0; i < t.characteristic.length; i++) {
    const a = rotated[t.characteristic[i] % 12];
    const b = rotated[t.contrast[i] % 12];
    // A ratio between two near-silent bins is arithmetically large and
    // musically meaningless. Discount the contrast by how much energy is
    // actually present, so weak evidence pushes toward abstention rather than
    // toward a confident answer.
    const reliability = clamp(
      (a + b) / PARAMS.DIAGNOSTIC_RELIABILITY_SCALE, 0, 1,
    );
    acc += reliability * ((a - b) / (a + b + 1e-9));
  }
  return clamp(acc / Math.max(1, t.characteristic.length), -1, 1);
}

/**
 * Scale membership: mean energy ON the mode's scale degrees versus mean energy
 * OFF them, as a normalised contrast in [-1, 1].
 *
 * This encodes the argument a musician makes out loud. Faced with material over
 * an E bass containing E F G A B C D, "E Aeolian" is not a competing hypothesis
 * to be weighed -- it is refuted, because Aeolian needs an F#, and there is no
 * F# anywhere in the track. Pure template correlation cannot make that argument
 * forcefully, because its weights are dominated by the tonic and fifth, so a
 * single missing degree barely moves it.
 *
 * WHY THIS IS A CONTRAST OF MEANS AND NOT A COUNT. The first implementation
 * counted degrees above 12% of the profile maximum. On synthetic tones that
 * worked; on real audio it was measured returning EXACTLY 0.00 for every
 * hypothesis, because a real mix has audible energy on all twelve pitch classes,
 * so coverage and intrusion both saturated at 1 and cancelled. A threshold-free
 * contrast of means degrades gracefully instead of silently switching itself off
 * on precisely the material the system is built for.
 */
export function scaleEvidence(rotated: Float64Array, t: ModeTemplate): number {
  const inScale = new Set(t.degrees.map((d) => d % 12));
  let sIn = 0, nIn = 0, sOut = 0, nOut = 0;
  for (let i = 0; i < 12; i++) {
    if (inScale.has(i)) { sIn += rotated[i]; nIn++; }
    else { sOut += rotated[i]; nOut++; }
  }
  if (!nIn || !nOut) return 0;
  const mIn = sIn / nIn;
  const mOut = sOut / nOut;
  return clamp((mIn - mOut) / (mIn + mOut + 1e-9), -1, 1);
}

/** The Phrygian tell in isolation, reported separately for transparency. */
export function flat2Evidence(hpcp: ArrayLike<number>, tonic: number): number {
  const flat2 = hpcp[(tonic + 1) % 12];
  const nat2 = hpcp[(tonic + 2) % 12];
  return clamp((flat2 - nat2) / (flat2 + nat2 + 1e-9), -1, 1);
}

/**
 * Tonal clarity: 1 - normalised Shannon entropy of the pitch class profile.
 *
 * This exists because template correlation on its own is not safe. An HPCP has
 * only 12 dimensions, and a flat, noisy profile will correlate with SOME mode
 * template at r ~ 0.55 purely by chance -- measured, not assumed: white noise
 * through this exact pipeline scores 0.552 against D Phrygian. Without a tonal
 * content gate the classifier would confidently label a field recording.
 */
export function tonalClarity(hpcp: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < 12; i++) s += hpcp[i];
  if (s <= 0) return 0;
  let h = 0;
  for (let i = 0; i < 12; i++) {
    const p = hpcp[i] / s;
    if (p > 0) h -= p * Math.log(p);
  }
  return clamp(1 - h / Math.log(12), 0, 1);
}

export interface TonicPriorInput {
  /** global harmonic pitch class profile — the only required input */
  hpcp: Float64Array;

  // ---- structural profiles, available only from per-frame audio analysis ----
  hpcpBass?: Float64Array;          // bass register only (< ~250 Hz)
  hpcpDownbeat?: Float64Array;      // downbeat-weighted
  hpcpPhraseFinal?: Float64Array;   // phrase-final positions

  /**
   * Use the chord histogram as the TONIC PRIOR.
   *
   * Off by default because it was measured to make things worse, not better:
   * on 1,908 AcousticBrainz records, major/minor family agreement with Essentia
   * fell from 70% to 53% when the chord-root histogram drove the tonic prior.
   * The most-played chord is frequently the dominant or subdominant rather than
   * the tonic, so it pulls the answer off the tonal centre. Kept behind a flag
   * because the measurement is worth being able to reproduce.
   */
  useChordPrior?: boolean;

  /**
   * 24-bin chord histogram: indices 0-11 are MAJOR chords rooted at C..B,
   * 12-23 are MINOR chords rooted at C..B.
   *
   * This is the substitute tonic prior for corpora that publish aggregate
   * features rather than audio (AcousticBrainz). It cannot tell us which pitch
   * class sits in the bass or lands on a downbeat, but it does say which chord
   * roots the harmony actually dwells on -- which is a HARMONIC rather than
   * REGISTRAL route to the same question, and arguably a more direct one.
   */
  chordsHistogram?: Float64Array;
}

/**
 * Structural emphasis prior over the 12 possible tonics.
 *
 * Plan section 2.1 step 2: weight pitch classes by structural emphasis rather
 * than raw duration. A pad holding a C for 8 bars under an E-centred bassline
 * should not win the tonic vote, and under a duration-weighted profile it does.
 */
export function tonicPrior(inp: TonicPriorInput): Float64Array {
  const norm = (v: Float64Array) => {
    let s = 0;
    for (let i = 0; i < 12; i++) s += v[i];
    const out = new Float64Array(12);
    if (s <= 0) return out.fill(1 / 12);
    for (let i = 0; i < 12; i++) out[i] = v[i] / s;
    return out;
  };

  const out = new Float64Array(12);
  const hasStructural = Boolean(inp.hpcpBass && inp.hpcpDownbeat && inp.hpcpPhraseFinal);

  if (hasStructural) {
    const b = norm(inp.hpcpBass!);
    const d = norm(inp.hpcpDownbeat!);
    const p = norm(inp.hpcpPhraseFinal!);
    const g = norm(inp.hpcp);
    for (let i = 0; i < 12; i++) {
      out[i] =
        PARAMS.PRIOR_BASS * b[i] +
        PARAMS.PRIOR_DOWNBEAT * d[i] +
        PARAMS.PRIOR_PHRASE_FINAL * p[i] +
        PARAMS.PRIOR_GLOBAL * g[i];
    }
  } else if (inp.useChordPrior && inp.chordsHistogram && inp.chordsHistogram.length === 24) {
    // Total time spent on a chord ROOTED at each pitch class, major or minor.
    // The tonal centre is usually the chord root the harmony returns to most.
    const roots = new Float64Array(12);
    for (let i = 0; i < 12; i++) {
      roots[i] = inp.chordsHistogram[i] + inp.chordsHistogram[i + 12];
    }
    const r = norm(roots);
    const g = norm(inp.hpcp);
    // Chord roots carry most of the weight; the raw profile only breaks ties,
    // because on aggregate data it is the weaker of the two signals.
    for (let i = 0; i < 12; i++) out[i] = 0.75 * r[i] + 0.25 * g[i];
  } else {
    // No structural evidence at all. Fall back to the raw profile and accept
    // that the tonic prior contributes nothing beyond what correlation sees.
    out.set(norm(inp.hpcp));
  }

  let mx = 0;
  for (let i = 0; i < 12; i++) if (out[i] > mx) mx = out[i];
  if (mx > 0) for (let i = 0; i < 12; i++) out[i] /= mx;
  return out;
}

/**
 * Does the harmony spell the tonic as a MAJOR or MINOR chord?
 *
 * Returns +1 for unambiguously major, -1 for unambiguously minor, 0 when there
 * is no chord evidence. Modes are then rewarded for agreeing with it: if the
 * tonic chord is minor, a mode with a minor third fits the harmony and one with
 * a major third does not. This recovers part of what the lost bass-register
 * prior was providing.
 */
export function tonicChordQuality(
  chords: Float64Array | undefined,
  tonic: number,
): number {
  if (!chords || chords.length !== 24) return 0;
  const maj = chords[tonic];
  const min = chords[tonic + 12];
  if (maj + min <= 0) return 0;
  return clamp((maj - min) / (maj + min), -1, 1);
}

const HAS_MAJOR_THIRD = new Set<ModeName>([
  'ionian', 'lydian', 'mixolydian', 'phrygian_dominant', 'whole_tone',
]);

export interface Hypothesis {
  tonic: number;
  mode: ModeName;
  /** total score: template fit + prior + diagnostic */
  score: number;
  /** raw template correlation, before any prior or diagnostic adjustment */
  correlation: number;
  prior: number;
  diagnostic: number;
  coverage: number;
  label: string;
}

export interface ModeResult {
  tonic: number;
  tonicConfidence: number;
  mode: ModeOrUnclear;
  modeConfidence: number;
  keyName: string;
  flat2Evidence: number;
  /** 1 - normalised entropy of the HPCP; near 0 means "no tonal content at all" */
  tonalClarity: number;
  /** every hypothesis, best first — this is what the UI renders as "show your work" */
  ranked: Hypothesis[];
  /** best hypothesis per mode name, for compact storage */
  perMode: Record<string, number>;
  /** what a major/minor-only detector would have said, given the same evidence */
  collapsedLabel: string;
  abstained: boolean;
}

export function keyName(tonic: number, mode: ModeOrUnclear): string {
  if (mode === 'unclear') return `${PITCH_NAMES[tonic]} (mode unclear)`;
  const t = MODE_TEMPLATES.find((m) => m.name === mode)!;
  return `${PITCH_NAMES[tonic]} ${t.display.replace(/ \(.*\)$/, '')}`;
}

/**
 * Joint tonic + mode estimation over all 12 x 10 hypotheses.
 */
export function classifyMode(
  inp: TonicPriorInput,
  overrides?: Partial<typeof PARAMS>,
): ModeResult {
  const P = { ...PARAMS, ...overrides };
  const prior = tonicPrior(inp);
  // unit-max normalise so that presence/reliability thresholds have a fixed
  // meaning regardless of excerpt length or level
  const h = normMax(inp.hpcp);
  const hyps: Hypothesis[] = [];

  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = rotateToTonic(h, tonic);
    for (const tpl of MODE_TEMPLATES) {
      const correlation = pearson(rotated, TEMPLATE_VECTORS[tpl.name]);
      const diagnostic = characteristicEvidence(rotated, tpl);
      const coverage = scaleEvidence(rotated, tpl);
      // agreement between the mode's third and the tonic chord's quality
      const quality = tonicChordQuality(inp.chordsHistogram, tonic)
        * (HAS_MAJOR_THIRD.has(tpl.name) ? 1 : -1);
      let score =
        correlation +
        P.TONIC_PRIOR_WEIGHT * prior[tonic] +
        P.DIAGNOSTIC_WEIGHT * diagnostic +
        P.COVERAGE_WEIGHT * coverage +
        P.CHORD_QUALITY_WEIGHT * quality;
      if (tpl.name === 'locrian') score -= P.LOCRIAN_PENALTY;
      hyps.push({
        tonic,
        mode: tpl.name,
        score,
        correlation,
        prior: prior[tonic],
        diagnostic,
        coverage,
        label: keyName(tonic, tpl.name),
      });
    }
  }

  hyps.sort((a, b) => b.score - a.score);
  const best = hyps[0];

  // margin against the best hypothesis carrying a DIFFERENT mode name
  const bestOtherMode = hyps.find((h) => h.mode !== best.mode);
  const modeMargin = bestOtherMode ? best.score - bestOtherMode.score : best.score;

  // margin against the best hypothesis at a DIFFERENT tonic
  const bestOtherTonic = hyps.find((h) => h.tonic !== best.tonic);
  const tonicMargin = bestOtherTonic ? best.score - bestOtherTonic.score : best.score;

  const fitQuality = clamp(
    (best.correlation - P.FIT_FLOOR) / (P.FIT_CEIL - P.FIT_FLOOR),
    0, 1,
  );
  // Three independent things must all hold before a label is worth reporting:
  // the profile must fit a template, the winner must be clearly ahead of the
  // runner-up, and the profile must carry tonal information in the first place.
  // A geometric mean means any one of them failing collapses the confidence.
  const clarity = tonalClarity(h);
  const clarityQ = clamp(
    (clarity - P.CLARITY_FLOOR) / (P.CLARITY_CEIL - P.CLARITY_FLOOR),
    0, 1,
  );
  const modeConfidence = Math.cbrt(
    fitQuality * clamp(modeMargin / P.MARGIN_FULL, 0, 1) * clarityQ,
  );
  const tonicConfidence = Math.cbrt(
    fitQuality * clamp(tonicMargin / P.MARGIN_FULL, 0, 1) * clarityQ,
  );

  const abstained = modeConfidence < P.ABSTAIN;
  const mode: ModeOrUnclear = abstained ? 'unclear' : best.mode;

  const perMode: Record<string, number> = {};
  for (const h of hyps) {
    const k = `${PITCH_NAMES[h.tonic]}_${h.mode}`;
    if (perMode[k] === undefined) perMode[k] = Number(h.score.toFixed(4));
  }
  const compact: Record<string, number> = {};
  for (const tpl of MODE_TEMPLATES) {
    const b = hyps.find((h) => h.mode === tpl.name)!;
    compact[tpl.name] = Number(b.score.toFixed(4));
    compact[`${tpl.name}_tonic`] = b.tonic;
  }

  const collapsed = MODE_TEMPLATES.find((m) => m.name === best.mode)!.collapsesTo;

  return {
    tonic: best.tonic,
    tonicConfidence,
    mode,
    modeConfidence,
    keyName: keyName(best.tonic, mode),
    flat2Evidence: flat2Evidence(h, best.tonic),
    tonalClarity: Number(clarity.toFixed(4)),
    ranked: hyps.slice(0, 12),
    perMode: compact,
    collapsedLabel: `${PITCH_NAMES[best.tonic]} ${collapsed}`,
    abstained,
  };
}
