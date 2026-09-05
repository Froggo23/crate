import { analyzePcm } from '../src/lib/dsp/core';
import { PITCH_NAMES, MODE_TEMPLATES } from '../src/lib/dsp/modes';
const SR = 22050;

// white noise
const n = Math.floor(20 * SR); const x = new Float64Array(n);
let seed = 7; const rnd = () => { seed = (seed*1103515245+12345)&0x7fffffff; return seed/0x7fffffff-0.5; };
for (let i=0;i<n;i++) x[i]=rnd()*0.3;
const r = analyzePcm(x, SR);
console.log('WHITE NOISE');
console.log('  hpcp      :', r.hpcp.map(v=>v.toFixed(2)).join(' '));
console.log('  hpcpBass  :', r.hpcpBass.map(v=>v.toFixed(2)).join(' '));
console.log('  top hyps  :');
for (const h of r.mode.ranked.slice(0,4)) console.log(`    ${h.label.padEnd(24)} score=${h.score.toFixed(3)} corr=${h.correlation.toFixed(3)} prior=${h.prior.toFixed(3)} diag=${h.diagnostic.toFixed(3)}`);
const sum = r.hpcp.reduce((a,b)=>a+b,0);
const p = r.hpcp.map(v=>v/sum);
const H = -p.reduce((a,q)=> a + (q>0? q*Math.log(q):0), 0) / Math.log(12);
console.log('  normalised entropy:', H.toFixed(4), '-> tonalClarity', (1-H).toFixed(4));
console.log('  flatness (min/max):', (Math.min(...r.hpcp)/Math.max(...r.hpcp)).toFixed(3));

// sine sweep across octaves -> should be roughly flat in pitch class
const m = Math.floor(20*SR); const y = new Float64Array(m);
for (let i=0;i<m;i++){ const t=i/SR; const f=80*Math.pow(2, 5*t/20); y[i]=Math.sin(2*Math.PI*f*t*1)*0.5; }
const r2 = analyzePcm(y, SR);
console.log('\nLOG SWEEP 80Hz->2560Hz (should be near-flat across pitch classes)');
console.log('  hpcp:', r2.hpcp.map(v=>v.toFixed(2)).join(' '));
const s2=r2.hpcp.reduce((a,b)=>a+b,0); const p2=r2.hpcp.map(v=>v/s2);
console.log('  normalised entropy:', (-p2.reduce((a,q)=>a+(q>0?q*Math.log(q):0),0)/Math.log(12)).toFixed(4));

// pure tonal: sustained C major triad
const k = Math.floor(20*SR); const z = new Float64Array(k);
for (const f of [261.63, 329.63, 392.00]) for (let i=0;i<k;i++){ const t=i/SR; for(let h=1;h<=6;h++) z[i]+=Math.sin(2*Math.PI*f*h*t)/h*0.08; }
const r3 = analyzePcm(z, SR);
console.log('\nSUSTAINED C MAJOR TRIAD');
console.log('  hpcp:', r3.hpcp.map(v=>v.toFixed(2)).join(' '), ' (C=idx0 E=4 G=7)');
const s3=r3.hpcp.reduce((a,b)=>a+b,0); const p3=r3.hpcp.map(v=>v/s3);
console.log('  normalised entropy:', (-p3.reduce((a,q)=>a+(q>0?q*Math.log(q):0),0)/Math.log(12)).toFixed(4));
console.log('  best:', r3.mode.keyName, 'conf', r3.mode.modeConfidence.toFixed(3), 'corr', r3.mode.ranked[0].correlation.toFixed(3));
