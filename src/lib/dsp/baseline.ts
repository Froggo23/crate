/**
 * The baseline CRATE has to beat.
 *
 * Essentia's KeyExtractor -- the same code path behind AcousticBrainz, and by
 * extension the features most MIR work is built on -- correlates a pitch class
 * profile against a pair of key profiles and reports the best of 24 (12 tonics
 * x major/minor). The profile set is configurable (krumhansl, temperley, edma,
 * bgate); the algorithm is the same.
 *
 * Reimplementing it here rather than shelling out to Essentia is deliberate:
 *   - it runs in the same process on the same HPCP, so the comparison isolates
 *     the classifier and not the front end;
 *   - Essentia is a C++/Python build that cannot be deployed to Vercel, and a
 *     baseline you cannot run in production is a baseline you cannot audit;
 *   - it is the honest control condition. Both systems see identical input.
 *
 * The structural limitation being demonstrated is not an implementation detail:
 * with only major and minor templates, E Phrygian has no representation at all.
 * The best available answer is C major or A minor, and the detector will give
 * one of them confidently.
 */

import { pearson } from './fft';
import { PITCH_NAMES, rotateToTonic } from './modes';

export type ProfileSet = 'krumhansl' | 'temperley';

/** Krumhansl & Kessler (1982), from probe-tone experiments. */
const KRUMHANSL = {
  major: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
  minor: [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
};

/** Temperley (2001), tuned on notated corpora rather than listener ratings. */
const TEMPERLEY = {
  major: [5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0],
  minor: [5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0],
};

export interface BaselineResult {
  key: number;
  mode: 'major' | 'minor';
  keyName: string;
  correlation: number;
  /** the mode name this collapses to in CRATE's vocabulary */
  asMode: 'ionian' | 'aeolian';
  profileSet: ProfileSet;
}

export function baselineKey(
  hpcp: ArrayLike<number>,
  profileSet: ProfileSet = 'krumhansl',
): BaselineResult {
  const P = profileSet === 'temperley' ? TEMPERLEY : KRUMHANSL;
  let best: BaselineResult | null = null;
  for (let t = 0; t < 12; t++) {
    const rotated = rotateToTonic(hpcp, t);
    for (const mode of ['major', 'minor'] as const) {
      const c = pearson(rotated, P[mode]);
      if (!best || c > best.correlation) {
        best = {
          key: t,
          mode,
          keyName: `${PITCH_NAMES[t]} ${mode}`,
          correlation: c,
          asMode: mode === 'major' ? 'ionian' : 'aeolian',
          profileSet,
        };
      }
    }
  }
  return best!;
}
