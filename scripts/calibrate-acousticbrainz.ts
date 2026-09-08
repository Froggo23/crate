import './env';
import { walkJson, parseRecord } from '../src/lib/sources/acousticbrainz';
import { foldHpcp36 } from '../src/lib/dsp/hpcp';
import { classifyMode, PITCH_NAMES, PARAMS } from '../src/lib/dsp/modes';

const MAJOR_FAMILY = new Set(['ionian', 'lydian', 'mixolydian', 'whole_tone']);
const flat: Record<string, string> = { Db:'C#', Eb:'D#', Gb:'F#', Ab:'G#', Bb:'A#' };

interface Rec { h: Float64Array; chords?: Float64Array; key: number | null; scale: string | null }

async function load(): Promise<Rec[]> {
  const out: Rec[] = [];
  for await (const p of walkJson('/tmp/absample')) {
    const r = await parseRecord(p, null);
    if (!r) continue;
    const k = r.essentiaKey ? (flat[r.essentiaKey] ?? r.essentiaKey) : null;
    const idx = k ? (PITCH_NAMES as readonly string[]).indexOf(k) : -1;
    out.push({
      h: foldHpcp36(r.hpcp36),
      chords: r.chordsHistogram.length === 24 ? Float64Array.from(r.chordsHistogram) : undefined,
      key: idx >= 0 ? idx : null,
      scale: r.essentiaScale ?? null,
    });
  }
  return out;
}

function run(recs: Rec[], mode: 'none' | 'quality' | 'prior') {
  let unclear = 0, famAgree = 0, famN = 0, lyd = 0;
  const dist = new Map<string, number>();
  for (const r of recs) {
    const m = classifyMode({
      hpcp: r.h,
      chordsHistogram: mode === 'none' ? undefined : r.chords,
      useChordPrior: mode === 'prior',
    });
    dist.set(m.mode, (dist.get(m.mode) ?? 0) + 1);
    if (m.mode === 'unclear') { unclear++; continue; }
    if (m.mode === 'lydian') lyd++;
    if (r.key != null && r.scale) {
      famN++;
      const ourFam = MAJOR_FAMILY.has(m.mode) ? 'major' : 'minor';
      if (ourFam === r.scale) famAgree++;
    }
  }
  const n = recs.length;
  return {
    unclearPct: (100 * unclear) / n,
    familyPct: famN ? (100 * famAgree) / famN : 0,
    lydianPct: (100 * lyd) / n,
    dist,
  };
}

async function main() {
  const recs = await load();
  console.log(`n = ${recs.length}\n`);
  console.log('Sweeping the tonal-clarity window. Targets: abstention well under 50%,');
  console.log('major/minor FAMILY agreement with Essentia high (we may be more specific');
  console.log('than it, but should not flip major<->minor), Lydian share low (<5% is');
  console.log('what real repertoire looks like).\n');
  console.log('  floor   ceil   chords   unclear   family   lydian');

  const results: { floor: number; ceil: number; chords: string; u: number; f: number; l: number }[] = [];
  for (const chords of ['none', 'quality', 'prior'] as const) {
    for (const floor of [0.010, 0.012]) {
      for (const ceil of [0.045, 0.060, 0.090]) {
        PARAMS.CLARITY_FLOOR = floor;
        PARAMS.CLARITY_CEIL = ceil;
        const r = run(recs, chords);
        results.push({ floor, ceil, chords, u: r.unclearPct, f: r.familyPct, l: r.lydianPct });
        console.log(`${floor.toFixed(3).padStart(7)} ${ceil.toFixed(3).padStart(6)} ${chords.padStart(8)} ` +
          `${r.unclearPct.toFixed(1).padStart(8)}% ${r.familyPct.toFixed(1).padStart(7)}% ${r.lydianPct.toFixed(1).padStart(7)}%`);
      }
    }
  }
  const ok = results.filter((r) => r.u < 45 && r.l < 9).sort((a, b) => b.f - a.f);
  console.log('\nbest by family agreement, with abstention <45% and Lydian <8%:');
  ok.slice(0, 4).forEach((r) =>
    console.log(`  floor ${r.floor} ceil ${r.ceil} chords=${r.chords} -> family ${r.f.toFixed(1)}%, unclear ${r.u.toFixed(1)}%, lydian ${r.l.toFixed(1)}%`));
}
main().catch((e) => { console.error(e); process.exit(1); });
