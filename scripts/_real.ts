import { scrapePage, itemTracks } from '../src/lib/sources/archive';
import { analyzeUrl } from '../src/lib/dsp/analyze';
import { USER_AGENT } from '../src/lib/net';

async function main() {
  const { items, total } = await scrapePage(null, 100, 'collection:netlabels AND mediatype:audio AND subject:(techno OR ambient OR electronic)');
  console.log(`matched ${total} items; probing first few\n`);

  let done = 0;
  for (const it of items) {
    if (done >= 5) break;
    let cands;
    try { cands = await itemTracks(it, 1); } catch (e) { continue; }
    if (!cands.length) continue;
    const c = cands[0];
    const t0 = Date.now();
    try {
      const r = await analyzeUrl(c.audioUrl, { userAgent: USER_AGENT, knownDurationSec: c.durationSec });
      done++;
      console.log(`${done}. ${c.artistName} — ${c.title}`);
      console.log(`   ${c.licenseShort ?? 'license?'} | ${(c.durationSec ?? 0).toFixed(0)}s | tags: ${c.tags.slice(0,4).join(', ')}`);
      console.log(`   BPM ${r.tempo.bpm.toFixed(1)} (conf ${r.tempo.bpmConfidence.toFixed(2)})  energy ${r.energy.toFixed(2)}  bright ${r.brightness.toFixed(2)}  instr ${r.instrumentalLikelihood.toFixed(2)}`);
      console.log(`   CRATE:    ${r.mode.keyName}  (conf ${r.mode.modeConfidence.toFixed(2)}, clarity ${r.mode.tonalClarity.toFixed(3)})`);
      console.log(`   baseline: ${r.baseline.keyName}  (r=${r.baseline.correlation.toFixed(3)})`);
      console.log(`   top-3: ${r.mode.ranked.slice(0,3).map(h=>`${h.label} ${h.score.toFixed(2)}`).join(' | ')}`);
      console.log(`   timing: probe ${r.timings.probeMs}ms decode ${r.timings.decodeMs}ms analyze ${r.timings.analyzeMs}ms  TOTAL ${r.timings.totalMs}ms\n`);
    } catch (e) {
      console.log(`   skip ${c.identifier}: ${(e as Error).message.slice(0,90)}`);
    }
  }

}
main();
