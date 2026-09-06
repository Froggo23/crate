import './env';
import { runSearch } from '../src/lib/search';
import { db } from '../src/lib/db';

const CASES: { q: string; expect: RegExp }[] = [
  { q: 'reggae dub', expect: /reggae|dub|ska|roots/i },
  { q: 'lo-fi hip hop', expect: /lo-?fi|hip.?hop|beat|jazz|downtempo/i },
  { q: 'dark ambient drone', expect: /ambient|drone|dark|noise|experimental/i },
  { q: 'glitchy experimental noise', expect: /glitch|noise|experimental|idm/i },
  { q: 'cinematic orchestral', expect: /cinema|orchestr|string|classical|score|soundtrack|piano/i },
  { q: 'minimal techno', expect: /techno|minimal|electronic|house/i },
];

async function main() {
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
}
main().catch((e) => { console.error(e); process.exit(1); });
