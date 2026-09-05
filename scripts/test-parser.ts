/**
 * Parser regression set.
 *
 * Plan, Phase 3: "Write and iterate the parser prompt. Build a test set of 50
 * queries with expected parses and run it on every prompt change."
 *
 * Each case asserts only the fields that the query genuinely determines. Over-
 * specifying would make the suite fail on harmless variation (94-106 vs 95-105)
 * and train you to ignore it, so bounds are checked as ranges and free text is
 * never asserted at all.
 *
 *   npx tsx scripts/test-parser.ts
 *   npx tsx scripts/test-parser.ts --fallback   # exercise the rule-based parser
 */

import './env';
import { parseQuery, fallbackParse } from '../src/lib/llm/parse';
import type { ParsedQuery } from '../src/lib/llm/schema';

type Check = (q: ParsedQuery) => string | null;

const near = (field: keyof ParsedQuery, lo: number, hi: number): Check => (q) => {
  const v = q[field] as number | null;
  if (v == null) return `${String(field)} was null, expected ${lo}..${hi}`;
  return v >= lo && v <= hi ? null : `${String(field)} = ${v}, expected ${lo}..${hi}`;
};
const isNull = (field: keyof ParsedQuery): Check => (q) =>
  q[field] == null ? null : `${String(field)} = ${JSON.stringify(q[field])}, expected null`;
const eq = (field: keyof ParsedQuery, val: unknown): Check => (q) =>
  JSON.stringify(q[field]) === JSON.stringify(val) ? null : `${String(field)} = ${JSON.stringify(q[field])}, expected ${JSON.stringify(val)}`;
const hasMode = (m: string): Check => (q) =>
  q.modes?.includes(m as never) ? null : `modes = ${JSON.stringify(q.modes)}, expected to include ${m}`;
const modesWithin = (...allowed: string[]): Check => (q) =>
  !q.modes || q.modes.every((m) => allowed.includes(m)) ? null : `modes = ${JSON.stringify(q.modes)}, expected a subset of ${allowed.join('/')}`;
const semanticNonEmpty: Check = (q) => (q.semantic.trim().length > 3 ? null : 'semantic was empty');
const tagLike = (sub: string): Check => (q) =>
  q.tags?.some((t) => t.includes(sub)) ? null : `tags = ${JSON.stringify(q.tags)}, expected one containing "${sub}"`;

interface Case { q: string; checks: Check[] }

const CASES: Case[] = [
  { q: 'dub techno from emerging artists, around 100 BPM',
    checks: [near('bpm_min', 88, 98), near('bpm_max', 102, 112), near('emergence_max', 0, 25), tagLike('dub'), semanticNonEmpty] },
  { q: 'uptempo electronica in Phrygian, no vocals, high energy',
    checks: [hasMode('phrygian'), eq('instrumental', true), near('energy_min', 0.5, 0.8), semanticNonEmpty] },
  { q: 'hazy and cavernous with warm tape saturation, dark on top',
    checks: [near('brightness_max', 0.2, 0.5), isNull('brightness_min'), isNull('bpm_min'), semanticNonEmpty] },
  { q: 'bright shimmering ambient, airy top end',
    checks: [near('brightness_min', 0.5, 0.8), isNull('brightness_max')] },
  { q: 'something in E Phrygian', checks: [eq('tonics', ['E']), hasMode('phrygian')] },
  { q: 'tracks in D Dorian around 120 bpm', checks: [eq('tonics', ['D']), hasMode('dorian'), near('bpm_min', 110, 118), near('bpm_max', 122, 130)] },
  { q: 'minor key downtempo', checks: [modesWithin('aeolian', 'dorian', 'phrygian', 'locrian', 'harmonic_minor')] },
  { q: 'major key uplifting stuff', checks: [modesWithin('ionian', 'lydian', 'mixolydian')] },
  { q: 'techno between 128 and 136 BPM', checks: [near('bpm_min', 127, 129), near('bpm_max', 135, 137)] },
  { q: 'anything with vocals', checks: [eq('instrumental', false)] },
  { q: 'instrumental only please', checks: [eq('instrumental', true)] },
  { q: 'obscure underground artists nobody knows', checks: [near('emergence_max', 0, 25)] },
  { q: 'calm ambient drone, very slow', checks: [near('energy_max', 0.2, 0.55)] },
  { q: 'released in 2015', checks: [near('year_min', 2015, 2015), near('year_max', 2015, 2015)] },
  { q: 'short tracks under three minutes', checks: [near('duration_max', 150, 190)] },
  { q: 'lo-fi hip hop beats', checks: [isNull('bpm_min'), semanticNonEmpty] },
  { q: 'Aphex Twin', checks: [isNull('modes'), isNull('bpm_min')] },
  { q: 'phrygian dominant, middle eastern flavour', checks: [hasMode('phrygian_dominant')] },
  { q: 'lydian, floating and dreamlike, instrumental', checks: [hasMode('lydian'), eq('instrumental', true)] },
  { q: 'heavy sub bass, murky, no top end at all', checks: [near('brightness_max', 0.15, 0.5), isNull('brightness_min')] },
  { q: 'ambient', checks: [isNull('bpm_min'), isNull('bpm_max'), semanticNonEmpty] },
  { q: 'roughly 90 bpm, emerging only, instrumental', checks: [near('bpm_min', 76, 86), near('bpm_max', 94, 104), near('emergence_max', 0, 25), eq('instrumental', true)] },
  { q: 'give me 5 results of dark minor techno', checks: [near('limit', 1, 10)] },
  { q: 'aeolian, sparse percussion, wide dynamics', checks: [hasMode('aeolian')] },
  { q: 'mixolydian with a flat seventh feel', checks: [hasMode('mixolydian')] },
];

async function main() {
  const useFallback = process.argv.includes('--fallback');
  console.log(`parser regression set — ${CASES.length} cases  (${useFallback ? 'rule-based fallback' : 'LLM'})`);
  console.log('='.repeat(88));

  let pass = 0, fail = 0;
  const failures: string[] = [];

  for (const c of CASES) {
    const q = useFallback ? fallbackParse(c.q) : (await parseQuery(c.q)).query;
    const errs = c.checks.map((f) => f(q)).filter(Boolean) as string[];
    if (errs.length === 0) { pass++; console.log(`  ok    ${c.q}`); }
    else {
      fail++;
      failures.push(c.q);
      console.log(`  FAIL  ${c.q}`);
      errs.forEach((e) => console.log(`          ${e}`));
    }
  }

  console.log('='.repeat(88));
  const rate = ((100 * pass) / CASES.length).toFixed(0);
  console.log(`${pass}/${CASES.length} passed (${rate}%)`);
  if (failures.length) console.log('failed: ' + failures.map((f) => `"${f}"`).join(', '));
  // The LLM parser is stochastic; a hard exit on one flake would make this
  // useless in CI. Fail only on a genuine regression in the pass rate.
  if (pass / CASES.length < 0.8) { console.log('\nPASS RATE BELOW 80% — treat as a regression'); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
