import './env';
import { runSearch } from '../src/lib/search';
import { db } from '../src/lib/db';

async function main() {
  const queries = [
    'dub techno from emerging artists, around 100 BPM',
    'uptempo electronica in Phrygian, no vocals, high energy',
    'something hazy and cavernous with warm tape saturation, dark on top',
  ];
  for (const qq of queries) {
    console.log('\n' + '='.repeat(78));
    console.log('QUERY:', qq);
    const r = await runSearch(qq, 'test-session', { log: false });
    const p = r.parsed;
    console.log('parsed:', JSON.stringify({
      bpm: [p.bpm_min, p.bpm_max], modes: p.modes, tonics: p.tonics,
      instrumental: p.instrumental, emergence_max: p.emergence_max,
      energy: [p.energy_min, p.energy_max], brightness: [p.brightness_min, p.brightness_max],
      tags: p.tags, limit: p.limit,
    }));
    console.log('semantic:', p.semantic);
    console.log('reasoning:', p.reasoning);
    console.log(`meta: parse ${r.meta.parseProvider}/${r.meta.parseModel} ${r.meta.parseMs}ms | embed ${r.meta.embedMs}ms | retrieve ${r.meta.retrieveMs}ms | rerank ${r.meta.rerankMs}ms reranked=${r.meta.reranked}`);
    console.log(`candidates ${r.candidateCount} -> ${r.results.length} results`);
    if (r.summary) console.log('summary:', r.summary);
    if (r.diagnostics) {
      console.log('DIAGNOSTIC:', r.diagnostics.message);
      console.log('  alone     :', JSON.stringify(r.diagnostics.alone));
      console.log('  cumulative:', JSON.stringify(r.diagnostics.cumulative));
    }
    for (const t of r.results.slice(0, 4)) {
      console.log(`  · ${t.artist_name} — ${t.title}`);
      console.log(`    ${(t.bpm??0).toFixed(0)}bpm ${t.mode==='unclear'?'mode unclear':t.key_name} conf ${(t.mode_confidence??0).toFixed(2)} | instr ${(t.instrumental_likelihood??0).toFixed(2)} | d=${t.distance?.toFixed(4)}`);
      if (t.reason) console.log(`    -> ${t.reason}`);
    }
  }
  await db().end();
}
main().catch((e) => { console.error(e); process.exit(1); });
