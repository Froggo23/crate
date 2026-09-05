/**
 * DSP correctness tests against synthetic signals with known ground truth.
 *
 * This is the Phase 0 gate from the project plan, run on material where the
 * answer is not in dispute. If the classifier cannot recover the mode of audio
 * that was literally synthesised FROM that mode, nothing downstream is worth
 * building.
 *
 *   npx tsx scripts/test-dsp.ts
 */

import { fft, pearson } from '../src/lib/dsp/fft';
import { analyzePcm } from '../src/lib/dsp/core';
import { MODE_TEMPLATES, PITCH_NAMES, ModeName } from '../src/lib/dsp/modes';
import { estimateTempo } from '../src/lib/dsp/tempo';
import { stft } from '../src/lib/dsp/fft';

const SR = 22050;
let pass = 0, fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}  ${detail}`); }
}

// ---------------------------------------------------------------------------
// 1. FFT against a naive DFT
// ---------------------------------------------------------------------------
function testFft() {
  console.log('\n[1] FFT vs naive DFT');
  const n = 256;
  const re = new Float64Array(n), im = new Float64Array(n);
  const orig: number[] = [];
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (let i = 0; i < n; i++) { const v = rnd(); re[i] = v; orig.push(v); }
  fft(re, im);
  let maxErr = 0;
  for (const k of [0, 1, 7, 33, 128]) {
    let dr = 0, di = 0;
    for (let t = 0; t < n; t++) {
      const a = (-2 * Math.PI * k * t) / n;
      dr += orig[t] * Math.cos(a);
      di += orig[t] * Math.sin(a);
    }
    maxErr = Math.max(maxErr, Math.abs(dr - re[k]), Math.abs(di - im[k]));
  }
  check('radix-2 matches DFT', maxErr < 1e-9, `max err ${maxErr.toExponential(2)}`);
}

// ---------------------------------------------------------------------------
// 2. a simple additive synth, so we can make audio with a known mode
// ---------------------------------------------------------------------------
const midiToHz = (m: number) => 440 * 2 ** ((m - 69) / 12);

interface Note { midi: number; start: number; dur: number; gain: number; partials: number; }

function render(notes: Note[], seconds: number): Float64Array {
  const x = new Float64Array(Math.floor(seconds * SR));
  for (const nt of notes) {
    const f0 = midiToHz(nt.midi);
    const s = Math.floor(nt.start * SR);
    const len = Math.floor(nt.dur * SR);
    const atk = Math.max(1, Math.floor(0.01 * SR));
    const rel = Math.max(1, Math.floor(0.25 * len));
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      let env = 1;
      if (i < atk) env = i / atk;
      else if (i > len - rel) env = Math.max(0, (len - i) / rel);
      let v = 0;
      for (let h = 1; h <= nt.partials; h++) {
        const f = f0 * h;
        if (f > SR / 2 - 100) break;
        v += Math.sin(2 * Math.PI * f * t) / h;
      }
      const idx = s + i;
      if (idx < x.length) x[idx] += v * env * nt.gain * 0.12;
    }
  }
  // light percussive layer so tempo estimation has something to lock onto
  const beat = 60 / 100;
  for (let b = 0; b * beat < seconds; b++) {
    const s = Math.floor(b * beat * SR);
    const len = Math.floor(0.05 * SR);
    const isDown = b % 4 === 0;
    for (let i = 0; i < len && s + i < x.length; i++) {
      const env = Math.exp(-i / (0.012 * SR));
      // kick on the downbeat, closed hat elsewhere
      const v = isDown
        ? Math.sin(2 * Math.PI * 55 * (i / SR)) * 1.4
        : (Math.sin(i * 7.13) * 0.5 + Math.sin(i * 3.7) * 0.5) * 0.25;
      x[s + i] += v * env * 0.5;
    }
  }
  return x;
}

/**
 * Build a passage that establishes `tonic`/`mode`.
 *
 * mode 'clear': the tonic is also the most prominent pitch class. Easy material.
 *
 * mode 'ambiguous': THE CASE THE PROJECT EXISTS FOR. The pitch class CONTENT is
 * identical to the parent major scale, and the harmony deliberately dwells on
 * the parent major triad and its dominant, so a duration- or energy-weighted
 * profile peaks on the parent major root, not on the modal tonic. The only cues
 * that the tonic is elsewhere are structural: a bass ostinato locked to it, its
 * placement on downbeats, and phrases resolving onto it.
 *
 * This is a synthetic reconstruction of the plan's claim in section 2.1 -- "a
 * track in E Phrygian will be detected as C major or A minor, because it shares
 * the same pitch class content".
 */
function synthesizeMode(
  tonicPc: number,
  mode: ModeName,
  seconds = 32,
  difficulty: 'clear' | 'ambiguous' = 'clear',
): Float64Array {
  const tpl = MODE_TEMPLATES.find((m) => m.name === mode)!;
  const scale = tpl.degrees;
  const notes: Note[] = [];
  const beat = 60 / 100;
  const bars = Math.floor(seconds / (beat * 4));

  const bassRoot = 36 + tonicPc;
  const padRoot = 60 + tonicPc;
  let seed = 99;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  // for the ambiguous case, the decoy centre is the parent major root
  const parentRel = tpl.parentOffset == null ? 0 : ((-tpl.parentOffset) % 12 + 12) % 12;
  const third = scale.find((d) => d === 3 || d === 4) ?? scale[1];
  const fifth = scale.includes(7) ? 7 : scale.includes(6) ? 6 : 5;

  for (let bar = 0; bar < bars; bar++) {
    const t0 = bar * beat * 4;

    // bass: the tonic, on the downbeat, in the bass register. Identical in both
    // difficulties -- this is the cue the classifier is supposed to be using.
    notes.push({ midi: bassRoot, start: t0, dur: beat * 1.8, gain: 1.5, partials: 8 });
    notes.push({ midi: bassRoot + fifth, start: t0 + beat * 2, dur: beat * 0.9, gain: 1.0, partials: 8 });

    if (difficulty === 'clear') {
      notes.push({ midi: padRoot, start: t0, dur: beat * 3.6, gain: 0.55, partials: 5 });
      notes.push({ midi: padRoot + third, start: t0, dur: beat * 3.6, gain: 0.5, partials: 5 });
      notes.push({ midi: padRoot + fifth, start: t0, dur: beat * 3.6, gain: 0.45, partials: 5 });
      for (const ch of tpl.characteristic) {
        notes.push({ midi: padRoot + ch, start: t0 + beat * 1.5, dur: beat * 2.0, gain: 0.5, partials: 5 });
      }
    } else {
      // dwell on the PARENT MAJOR triad (I) and its dominant (V), both of which
      // live inside the same seven notes but centre the ear somewhere else
      const chordRoot = padRoot + parentRel + (bar % 2 === 0 ? 0 : 7);
      for (const iv of [0, 4, 7]) {
        notes.push({ midi: chordRoot + iv, start: t0, dur: beat * 3.7, gain: 0.75, partials: 5 });
      }
      // and give the parent root extra melodic weight
      notes.push({ midi: padRoot + parentRel + 12, start: t0 + beat, dur: beat * 1.5, gain: 0.6, partials: 6 });
    }

    // melody: walks the scale, resolves onto the tonic at each phrase end
    for (let b = 0; b < 4; b++) {
      const isPhraseEnd = bar % 4 === 3 && b === 3;
      const deg = isPhraseEnd ? 0 : scale[Math.floor(rnd() * scale.length)];
      notes.push({
        midi: padRoot + 12 + deg,
        start: t0 + b * beat,
        dur: beat * 0.85,
        gain: isPhraseEnd ? 0.75 : 0.45,
        partials: 6,
      });
    }
  }
  return render(notes, seconds);
}

// ---------------------------------------------------------------------------
// 3. tempo
// ---------------------------------------------------------------------------
function testTempo() {
  console.log('\n[3] tempo estimation on a synthetic 100 BPM grid');
  const x = synthesizeMode(4, 'phrygian', 24);
  const s = stft(x, SR, 1024, 256);
  const t = estimateTempo(s);
  const ok = Math.abs(t.bpm - 100) < 3 || Math.abs(t.bpm - 200) < 5 || Math.abs(t.bpm - 50) < 3;
  check('recovers 100 BPM (octave-tolerant)', ok, `got ${t.bpm.toFixed(1)} conf ${t.bpmConfidence.toFixed(2)}`);
  check('produces a beat grid', t.beats.length > 10, `${t.beats.length} beats, ${t.downbeats.length} downbeats`);
}

// ---------------------------------------------------------------------------
// 4. the actual gate: modal classification vs the major/minor baseline
// ---------------------------------------------------------------------------
const CASES: { tonic: number; mode: ModeName }[] = [
  { tonic: 4,  mode: 'phrygian' },          // E Phrygian   — parent C major
  { tonic: 2,  mode: 'dorian' },            // D Dorian     — parent C major
  { tonic: 7,  mode: 'mixolydian' },        // G Mixolydian — parent C major
  { tonic: 5,  mode: 'lydian' },            // F Lydian     — parent C major
  { tonic: 9,  mode: 'aeolian' },           // A Aeolian    — parent C major
  { tonic: 0,  mode: 'ionian' },            // C Ionian
  { tonic: 11, mode: 'phrygian' },          // B Phrygian   — parent G major
  { tonic: 6,  mode: 'dorian' },            // F# Dorian    — parent E major
];

function runSuite(difficulty: 'clear' | 'ambiguous') {
  let ourTonic = 0, ourMode = 0, baseTonic = 0, baseMode = 0;
  const rows: string[] = [];

  for (const c of CASES) {
    const x = synthesizeMode(c.tonic, c.mode, 32, difficulty);
    const r = analyzePcm(x, SR);
    const tpl = MODE_TEMPLATES.find((m) => m.name === c.mode)!;

    const tOk = r.mode.tonic === c.tonic;
    const mOk = tOk && r.mode.mode === c.mode;
    if (tOk) ourTonic++;
    if (mOk) ourMode++;

    // The baseline is scored on the same two questions. It CANNOT express a
    // modal answer, so its mode score is capped at the Ionian/Aeolian cases by
    // construction -- that is the structural limitation, not a scoring trick.
    const bTOk = r.baseline.key === c.tonic;
    const bMOk = bTOk && r.baseline.asMode === c.mode;
    if (bTOk) baseTonic++;
    if (bMOk) baseMode++;

    rows.push(
      `    ${(PITCH_NAMES[c.tonic] + ' ' + c.mode).padEnd(22)}` +
      ` ours=${r.mode.keyName.padEnd(22)}${mOk ? 'OK' : tOk ? '~tonic' : '  X '}` +
      `  conf=${r.mode.modeConfidence.toFixed(2)} clar=${r.mode.tonalClarity.toFixed(2)}` +
      `  | baseline=${r.baseline.keyName.padEnd(9)}${bTOk ? 'tonic-ok' : 'COLLAPSED->' + PITCH_NAMES[r.baseline.key]}`,
    );
  }
  rows.forEach((r) => console.log(r));
  return { ourTonic, ourMode, baseTonic, baseMode, n: CASES.length };
}

export const BENCH: Record<string, unknown> = {};

function testModes() {
  console.log('\n[4a] CLEAR material — the tonic is also the loudest pitch class');
  const easy = runSuite('clear');
  console.log(`    ours  tonic ${easy.ourTonic}/${easy.n}  mode ${easy.ourMode}/${easy.n}`);
  console.log(`    base  tonic ${easy.baseTonic}/${easy.n}  mode ${easy.baseMode}/${easy.n}`);
  BENCH.clear = easy;
  check('clear material: tonic recovered', easy.ourTonic >= 7, `${easy.ourTonic}/${easy.n}`);
  check('clear material: mode recovered', easy.ourMode >= 6, `${easy.ourMode}/${easy.n}`);

  console.log('\n[4b] AMBIGUOUS material — harmony dwells on the PARENT MAJOR triad');
  console.log('     (pitch class content is identical to the relative major;');
  console.log('      only bass register, downbeat and phrase-final position disambiguate)');
  const hard = runSuite('ambiguous');
  console.log(`    ours  tonic ${hard.ourTonic}/${hard.n}  mode ${hard.ourMode}/${hard.n}`);
  console.log(`    base  tonic ${hard.baseTonic}/${hard.n}  mode ${hard.baseMode}/${hard.n}`);

  BENCH.ambiguous = hard;
  check(
    'GATE: beats the baseline at finding the tonal centre',
    hard.ourTonic > hard.baseTonic,
    `ours ${hard.ourTonic}/${hard.n} vs baseline ${hard.baseTonic}/${hard.n}`,
  );
  check(
    'GATE: baseline cannot express a modal answer',
    hard.baseMode < hard.ourMode,
    `baseline ${hard.baseMode}/${hard.n} vs ours ${hard.ourMode}/${hard.n} on full mode`,
  );
  check(
    'GATE: baseline collapses some modal material onto the relative major',
    hard.baseTonic < hard.n,
    `baseline lost the tonic on ${hard.n - hard.baseTonic}/${hard.n}`,
  );
  console.log(
    `\n    >>> GATE  tonic accuracy on ambiguous modal material:` +
    `  CRATE ${hard.ourTonic}/${hard.n}   Krumhansl-Schmuckler ${hard.baseTonic}/${hard.n}`,
  );
}

// ---------------------------------------------------------------------------
// 5. abstention: noise must not produce a confident label
// ---------------------------------------------------------------------------
function testAbstain() {
  console.log('\n[5] abstention on atonal material');
  const n = Math.floor(20 * SR);
  const x = new Float64Array(n);
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (let i = 0; i < n; i++) x[i] = rnd() * 0.3;
  const r = analyzePcm(x, SR);
  check('white noise yields low mode confidence', r.mode.modeConfidence < 0.5,
    `conf ${r.mode.modeConfidence.toFixed(3)} -> ${r.mode.mode}`);
}

// ---------------------------------------------------------------------------
// 6. descriptor vector contract
// ---------------------------------------------------------------------------
function testDescriptor() {
  console.log('\n[6] descriptor vector');
  const x = synthesizeMode(0, 'ionian', 16);
  const r = analyzePcm(x, SR);
  check('is 64-dimensional', r.descriptorVector.length === 64);
  const norm = Math.sqrt(r.descriptorVector.reduce((a, b) => a + b * b, 0));
  check('is L2-normalised', Math.abs(norm - 1) < 1e-3, `|v| = ${norm.toFixed(6)}`);
  check('is finite throughout', r.descriptorVector.every(Number.isFinite));
  check('hpcp is 12-dim and unit-max', r.hpcp.length === 12 && Math.max(...r.hpcp) === 1);
}

console.log('CRATE DSP test suite');
console.log('='.repeat(78));
testFft();
console.log('\n[2] synthesis harness — building modal test material');
check('synth produces audio', synthesizeMode(4, 'phrygian', 4).length > SR);
testTempo();
testModes();
testAbstain();
testDescriptor();
console.log('\n' + '='.repeat(78));
console.log(`${pass} passed, ${fail} failed`);

if (process.argv.includes('--json')) {
  const fs = require('node:fs') as typeof import('node:fs');
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/benchmark.json', JSON.stringify({
    generatedBy: 'scripts/test-dsp.ts',
    cases: CASES.map((c) => ({ tonic: PITCH_NAMES[c.tonic], mode: c.mode })),
    ...BENCH,
    passed: pass, failed: fail,
  }, null, 2));
  console.log('wrote data/benchmark.json');
}

if (fail) { console.log('failures: ' + failures.join(', ')); process.exit(1); }
