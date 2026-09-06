/**
 * Retrieval regression suite.
 *
 * Guards the failure this was written to fix: ordinary, non-curated queries
 * returning nothing. Before the tag/relaxation changes, 4 of these 20 queries
 * returned zero results and 9 returned fewer than five, because the parser was
 * emitting style tags as a hard SQL filter and inventing energy/brightness
 * bounds from adjectives.
 *
 * It measures three things that pull against each other, and all three matter:
 *   COVERAGE   — do ordinary queries return a usable page of results
 *   RELEVANCE  — are those results actually the requested style
 *   INTEGRITY  — are the hard constraints still inviolable
 *
 * The third is the one to watch. It is trivial to fix coverage by loosening
 * everything; that would make the system worthless, and this suite would still
 * pass on the first two metrics. A "no vocals" query returning a vocal track is
 * a failure no coverage number redeems.
 *
 *   npx tsx scripts/test-retrieval.ts
 */

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


/** Style queries paired with the tag vocabulary a correct answer should carry. */
const CASES: { q: string; expect: RegExp }[] = [
  { q: 'reggae dub', expect: /reggae|dub|ska|roots/i },
  { q: 'lo-fi hip hop', expect: /lo-?fi|hip.?hop|beat|jazz|downtempo/i },
  { q: 'dark ambient drone', expect: /ambient|drone|dark|noise|experimental/i },
  { q: 'glitchy experimental noise', expect: /glitch|noise|experimental|idm/i },
  { q: 'cinematic orchestral', expect: /cinema|orchestr|string|classical|score|soundtrack|piano/i },
  { q: 'minimal techno', expect: /techno|minimal|electronic|house/i },
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

  console.log('\n' + '='.repeat(70));
  console.log('RELEVANCE — does a matching style tag appear in the top 10?\n');
  let hits = 0;
  for (const c of CASES) {
    const r = await runSearch(c.q, 'quality', { log: false, skipRerank: true });
    const top = r.results.slice(0, 10);
    const matched = top.filter((t) => c.expect.test((t.tags ?? []).join(' ')) || c.expect.test(t.title));
    if (matched.length >= 3) hits++;
    console.log(`  ${String(matched.length).padStart(2)}/10  "${c.q}"`);
    console.log(`         top-3: ${top.slice(0, 3).map((t) => `${t.title.slice(0, 22)} [${(t.tags ?? []).slice(0, 3).join('/')}]`).join('  |  ')}`);
  }
  console.log(`\n  relevant (>=3 of top 10 tag-matched): ${hits}/${CASES.length}\n`);

  console.log('CONSTRAINT INTEGRITY — hard constraints must never be violated\n');
  const checks: { q: string; check: (rows: Awaited<ReturnType<typeof runSearch>>['results']) => string }[] = [
    { q: 'instrumental music, no vocals at all',
      check: (rows) => {
        const bad = rows.filter((t) => (t.instrumental_likelihood ?? 0) < 0.60);
        return bad.length ? `VIOLATION: ${bad.length} tracks below the instrumental threshold` : `ok — all ${rows.length} instrumental`;
      } },
    { q: 'tracks in Phrygian only',
      check: (rows) => {
        const bad = rows.filter((t) => t.mode !== 'phrygian');
        return bad.length ? `VIOLATION: ${bad.length} non-Phrygian (${[...new Set(bad.map((b) => b.mode))].join(',')})` : `ok — all ${rows.length} Phrygian`;
      } },
    { q: 'anything between 120 and 130 bpm',
      check: (rows) => {
        const bad = rows.filter((t) => (t.bpm ?? 0) < 119 || (t.bpm ?? 999) > 131);
        return bad.length ? `VIOLATION: ${bad.length} outside the range` : `ok — all ${rows.length} in range`;
      } },
  ];
  for (const c of checks) {
    const r = await runSearch(c.q, 'quality', { log: false, skipRerank: true });
    const strict = r.results.filter((t) => !t.relaxed);
    console.log(`  "${c.q}"`);
    console.log(`     ${c.check(strict)}${r.relaxations.length ? `  (relaxed: ${r.relaxations.map((x) => x.note).join('; ')})` : ''}`);
  }

  

  await db().end();
  if (empty > 0) { console.log('\nREGRESSION: an ordinary query returned nothing'); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
