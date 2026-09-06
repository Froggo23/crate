import './env';
import { runSearch } from '../src/lib/search';
import { db } from '../src/lib/db';

const QUERIES = [
  'sad piano music',
  'something to fall asleep to',
  'aggressive drum and bass',
  'lo-fi hip hop',
  'happy upbeat electronic',
  'jazzy chill beats',
  'dark ambient drone',
  'fast punk',
  'reggae dub',
  '90s trance',
  'glitchy experimental noise',
  'romantic acoustic guitar',
  'cinematic orchestral',
  'deep house 124 bpm',
  'vaporwave',
  'something weird',
  'music for studying',
  'heavy bass wobble',
  'minimal techno for the gym',
  'melancholy strings in a minor key',
];

async function main() {
  let empty = 0, thin = 0;
  const rows: string[] = [];
  for (const q of QUERIES) {
    const r = await runSearch(q, 'probe', { log: false, skipRerank: true });
    const p = r.parsed;
    const active = Object.entries({
      bpm: p.bpm_min ?? p.bpm_max, modes: p.modes, tonics: p.tonics,
      instr: p.instrumental, energy: p.energy_min ?? p.energy_max,
      bright: p.brightness_min ?? p.brightness_max, tags: p.tags,
      year: p.year_min ?? p.year_max, dur: p.duration_min ?? p.duration_max,
      emerg: p.emergence_max, kw: p.keywords, conf: p.min_mode_confidence,
    }).filter(([, v]) => v != null && (!Array.isArray(v) || v.length)).map(([k]) => k);
    if (r.results.length === 0) empty++;
    if (r.results.length < 5) thin++;
    const rel = r.relaxations.length ? `  relaxed:${r.relaxations.length}` : '';
    rows.push(
      `${String(r.results.length).padStart(3)} (${String(r.strictCount).padStart(3)} strict)  ${q.padEnd(34)} [${active.join(',')}]${rel}` +
      (r.diagnostics?.culprit ? `  culprit=${r.diagnostics.culprit}` : ''),
    );
  }
  rows.forEach((x) => console.log(x));
  console.log('\n' + '='.repeat(70));
  console.log(`EMPTY: ${empty}/${QUERIES.length}  (${((100 * empty) / QUERIES.length).toFixed(0)}%)`);
  console.log(`thin (<5 results): ${thin}/${QUERIES.length}`);
  await db().end();
}
main().catch((e) => { console.error(e); process.exit(1); });
