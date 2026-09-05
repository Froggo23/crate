/**
 * The evaluation the project stands or falls on (plan sections 5 and 6).
 *
 * Two systems, one hand-labelled set, identical input. CRATE's joint tonic x mode
 * classifier versus a Krumhansl-Schmuckler key detector collapsed to modes -- the
 * same algorithm family Essentia's KeyExtractor uses, which is what almost all
 * published MIR features are derived from.
 *
 * The baseline is scored honestly, which means acknowledging that on any mode
 * outside Ionian and Aeolian its ceiling is zero: it has no template that can
 * express Dorian. That is the structural limitation being demonstrated, and it
 * is stated rather than hidden inside an aggregate.
 */

import { db } from './db';
import { MODE_TEMPLATES } from './dsp/modes';

export interface PerModeRow {
  mode: string;
  support: number;
  crate: { tp: number; fp: number; fn: number; precision: number; recall: number; f1: number };
  baseline: { tp: number; fp: number; fn: number; precision: number; recall: number; f1: number; expressible: boolean };
}

export interface EvalReport {
  labelled: number;
  perMode: PerModeRow[];
  overall: {
    crate: { tonicAccuracy: number; modeAccuracy: number; modeAccuracyOnDecided: number; abstentionRate: number };
    baseline: { tonicAccuracy: number; modeAccuracy: number };
  };
  confusion: { truth: string; predicted: string; n: number }[];
  /** how often the baseline landed on the relative major/minor instead */
  relativeCollapse: { n: number; of: number };
  notes: string[];
}

const BASELINE_EXPRESSIBLE = new Set(['ionian', 'aeolian']);

function prf(tp: number, fp: number, fn: number) {
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { tp, fp, fn, precision: +precision.toFixed(3), recall: +recall.toFixed(3), f1: +f1.toFixed(3) };
}

export async function buildEvalReport(): Promise<EvalReport> {
  const rows = await db()`
    select
      ml.labeled_tonic, ml.labeled_mode,
      f.tonic, f.mode, f.mode_confidence,
      f.baseline_key, f.baseline_mode
    from mode_labels ml
    join audio_features f on f.track_id = ml.track_id`;

  const labelled = rows.length;
  const modes = Array.from(new Set(rows.map((r) => r.labeled_mode as string))).sort();

  const perMode: PerModeRow[] = modes.map((m) => {
    let ctp = 0, cfp = 0, cfn = 0, btp = 0, bfp = 0, bfn = 0, support = 0;
    for (const r of rows) {
      // A prediction only counts as correct if BOTH the tonic and the mode match.
      // Scoring the mode alone would credit "Dorian" on the wrong root, which is
      // exactly the error the project claims to fix.
      const truthIsM = r.labeled_mode === m;
      if (truthIsM) support++;

      const cPredIsM = r.mode === m;
      const cCorrect = cPredIsM && truthIsM && r.tonic === r.labeled_tonic;
      if (cCorrect) ctp++;
      else if (cPredIsM) cfp++;
      if (truthIsM && !cCorrect) cfn++;

      const bMode = r.baseline_mode === 'major' ? 'ionian' : 'aeolian';
      const bPredIsM = bMode === m;
      const bCorrect = bPredIsM && truthIsM && r.baseline_key === r.labeled_tonic;
      if (bCorrect) btp++;
      else if (bPredIsM) bfp++;
      if (truthIsM && !bCorrect) bfn++;
    }
    return {
      mode: m,
      support,
      crate: prf(ctp, cfp, cfn),
      baseline: { ...prf(btp, bfp, bfn), expressible: BASELINE_EXPRESSIBLE.has(m) },
    };
  });

  let cTonic = 0, cMode = 0, bTonic = 0, bMode = 0, abstained = 0, decided = 0, decidedCorrect = 0;
  let relative = 0;
  for (const r of rows) {
    if (r.tonic === r.labeled_tonic) cTonic++;
    if (r.mode === 'unclear') abstained++;
    else {
      decided++;
      if (r.tonic === r.labeled_tonic && r.mode === r.labeled_mode) decidedCorrect++;
    }
    if (r.tonic === r.labeled_tonic && r.mode === r.labeled_mode) cMode++;
    if (r.baseline_key === r.labeled_tonic) bTonic++;
    const bAsMode = r.baseline_mode === 'major' ? 'ionian' : 'aeolian';
    if (r.baseline_key === r.labeled_tonic && bAsMode === r.labeled_mode) bMode++;
    // Did the baseline land specifically on the PARENT MAJOR of the true mode,
    // or on that parent's relative minor?
    //
    // This is the precise claim being tested, so it is measured precisely. An
    // earlier version counted almost any interval as a "collapse", which made
    // the statistic indistinguishable from "wrong tonic" and therefore useless
    // as evidence. E Phrygian has parentOffset 4, so its parent major is C and
    // the collapse targets are exactly C major and A minor.
    if (r.baseline_key !== r.labeled_tonic) {
      const tpl = MODE_TEMPLATES.find((t) => t.name === r.labeled_mode);
      if (tpl?.parentOffset != null) {
        const parentRoot = ((r.labeled_tonic - tpl.parentOffset) % 12 + 12) % 12;
        const relMinor = (parentRoot + 9) % 12;
        if (r.baseline_key === parentRoot || r.baseline_key === relMinor) relative++;
      }
    }
  }

  const confusionMap = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.labeled_mode}|${r.mode}`;
    confusionMap.set(k, (confusionMap.get(k) ?? 0) + 1);
  }
  const confusion = Array.from(confusionMap.entries())
    .map(([k, n]) => { const [truth, predicted] = k.split('|'); return { truth, predicted, n }; })
    .sort((a, b) => b.n - a.n);

  const pct = (x: number) => (labelled ? +((100 * x) / labelled).toFixed(1) : 0);

  return {
    labelled,
    perMode,
    overall: {
      crate: {
        tonicAccuracy: pct(cTonic),
        modeAccuracy: pct(cMode),
        modeAccuracyOnDecided: decided ? +((100 * decidedCorrect) / decided).toFixed(1) : 0,
        abstentionRate: pct(abstained),
      },
      baseline: { tonicAccuracy: pct(bTonic), modeAccuracy: pct(bMode) },
    },
    confusion,
    relativeCollapse: { n: relative, of: labelled },
    notes: [
      'Both systems receive the identical HPCP. The comparison isolates the classifier, not the front end.',
      'The baseline can only ever emit Ionian or Aeolian, so its per-mode recall on every other mode is 0 by construction. That is the point, not a scoring artefact.',
      'CRATE abstains ("unclear") below a confidence threshold. Mode accuracy is reported both over all labelled tracks and over only the tracks where it committed to an answer.',
      'Labels are made by ear against the audio excerpt actually analysed, so labeller and classifier see the same 60 seconds.',
    ],
  };
}
