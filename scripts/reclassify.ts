/**
 * Re-run the mode classifier over the whole corpus, from stored HPCPs.
 *
 *   npx tsx scripts/reclassify.ts [--dry]
 *
 * The four structural pitch class profiles are persisted, so tuning the
 * classifier never requires touching the audio again. Change a weight in
 * modes.ts, run this, re-score against the hand labels. Seconds, not hours.
 *
 * Rows ingested before the phrase-final profile was persisted fall back to the
 * global profile for that term; they are counted and reported rather than
 * silently mixed in, because a partially-degraded prior would otherwise show up
 * as unexplained noise in the evaluation.
 */

import './env';
import { directDb } from '../src/lib/db';
import { classifyMode } from '../src/lib/dsp/modes';
import { baselineKey } from '../src/lib/dsp/baseline';
import { ANALYZER_VERSION } from '../src/lib/dsp/core';

const DRY = process.argv.includes('--dry');
const sql = directDb();

async function main() {
  const rows = await sql`
    select track_id, hpcp, hpcp_bass, hpcp_downbeat, hpcp_phrase_final, mode, mode_confidence, tonic
    from audio_features
    where hpcp is not null`;
  console.log(`${rows.length} tracks with stored HPCP${DRY ? '  (dry run)' : ''}`);

  let changedMode = 0, changedTonic = 0, nowDecided = 0, nowUnclear = 0, degradedPrior = 0;
  const before = { decided: 0 }, after = { decided: 0 };

  for (const r of rows) {
    const f = (v: unknown, fallback: number[]) =>
      Array.isArray(v) && v.length === 12 ? Float64Array.from(v as number[]) : Float64Array.from(fallback);
    const hpcp = Float64Array.from(r.hpcp as number[]);
    const base = Array.from(hpcp);
    if (!Array.isArray(r.hpcp_phrase_final)) degradedPrior++;

    const result = classifyMode({
      hpcp,
      hpcpBass: f(r.hpcp_bass, base),
      hpcpDownbeat: f(r.hpcp_downbeat, base),
      hpcpPhraseFinal: f(r.hpcp_phrase_final, base),
    });
    const bl = baselineKey(hpcp, 'krumhansl');

    if (r.mode !== 'unclear') before.decided++;
    if (result.mode !== 'unclear') after.decided++;
    if (r.mode !== result.mode) changedMode++;
    if (r.tonic !== result.tonic) changedTonic++;
    if (r.mode === 'unclear' && result.mode !== 'unclear') nowDecided++;
    if (r.mode !== 'unclear' && result.mode === 'unclear') nowUnclear++;

    if (!DRY) {
      await sql`
        update audio_features set
          tonic = ${result.tonic},
          tonic_confidence = ${result.tonicConfidence},
          mode = ${result.mode},
          mode_confidence = ${result.modeConfidence},
          key_name = ${result.keyName},
          flat2_evidence = ${result.flat2Evidence},
          mode_scores = ${sql.json({ ...result.perMode, tonal_clarity: result.tonalClarity, top: result.ranked.slice(0, 5) } as never)},
          baseline_key = ${bl.key},
          baseline_mode = ${bl.mode},
          baseline_key_name = ${bl.keyName},
          baseline_correlation = ${bl.correlation},
          analyzer_version = ${ANALYZER_VERSION}
        where track_id = ${r.track_id}`;
    }
  }

  const pct = (n: number) => ((100 * n) / Math.max(1, rows.length)).toFixed(1);
  console.log(`\ndecided: ${before.decided} -> ${after.decided}  (${pct(before.decided)}% -> ${pct(after.decided)}%)`);
  console.log(`mode changed on ${changedMode}, tonic changed on ${changedTonic}`);
  console.log(`newly decided ${nowDecided}, newly abstained ${nowUnclear}`);
  if (degradedPrior) {
    console.log(`\nNOTE: ${degradedPrior} rows predate the phrase-final profile and fell back to the global HPCP for that term.`);
    console.log('      Re-ingest those tracks for a fully faithful prior.');
  }
  await sql.end();
}

main().catch(async (e) => { console.error(e); await sql.end().catch(() => {}); process.exit(1); });
