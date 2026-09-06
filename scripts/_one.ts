import './env';
import { runSearch } from '../src/lib/search';
import { db } from '../src/lib/db';
async function main() {
  for (const q of ['reggae dub', 'cinematic orchestral', 'lo-fi hip hop', '90s trance']) {
    const r = await runSearch(q, 'dbg', { log: false, skipRerank: true });
    console.log(`\n── "${q}"  -> ${r.results.length} results, ${r.candidateCount} candidates`);
    const shown = Object.fromEntries(
      Object.entries(r.parsed).filter(([k, v]) =>
        v != null && k !== 'semantic' && k !== 'reasoning' && (!Array.isArray(v) || v.length > 0)),
    );
    console.log('   parsed:', JSON.stringify(shown));
    console.log('   semantic:', r.parsed.semantic.slice(0,90));
    if (r.diagnostics) {
      console.log('   culprit:', r.diagnostics.culprit);
      const a = r.diagnostics.active;
      console.log('   alone:', JSON.stringify(Object.fromEntries(Object.entries(r.diagnostics.alone).filter(([k])=>a[k]))));
      console.log('   cumul:', JSON.stringify(Object.fromEntries(Object.entries(r.diagnostics.cumulative).filter(([k])=>a[k]))));
    }
  }
  await db().end();
}
main().catch((e)=>{console.error(e);process.exit(1);});
