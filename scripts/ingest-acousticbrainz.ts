/**
 * Ingest the AcousticBrainz sample dump.
 *
 *   npx tsx scripts/ingest-acousticbrainz.ts --limit 100000
 *
 * No audio is transferred. Every feature comes from the published dump; the
 * mode classifier runs here on the stored 36-bin HPCP folded to 12 semitones,
 * with the chord histogram standing in for the structural tonic prior that
 * per-frame analysis would have provided.
 *
 * Rows are tagged hpcp_source='acousticbrainz' so they are never silently
 * pooled with audio-analysed rows in an evaluation — the two tiers see
 * genuinely different amounts of information and comparing them is the point.
 */

import './env';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { directDb, toVector } from '../src/lib/db';
import { walkJson, parseRecord, AbRecord } from '../src/lib/sources/acousticbrainz';
import { foldHpcp36 } from '../src/lib/dsp/hpcp';
import { classifyMode, PITCH_NAMES, ModeName } from '../src/lib/dsp/modes';
import { buildAbCard } from '../src/lib/card';
import { embedTexts } from '../src/lib/embed';
import { clamp } from '../src/lib/dsp/fft';

const args = process.argv.slice(2);
const arg = (n: string, d: string) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const LIMIT = parseInt(arg('limit', '100000'), 10);
const LOW_ROOT = arg('low', '.data/extract/acousticbrainz-lowlevel-sample-json-20220623/lowlevel');
const HIGH_ROOT = arg('high', '/tmp/abhigh/acousticbrainz-highlevel-sample-json-20220623');
const BATCH = 400;

const sql = directDb();
const ANALYZER = 'crate-ab/1.0.0';

/**
 * Source-specific classifier calibration, measured on 1,908 sampled records.
 *
 * Essentia's AGGREGATE hpcp is flatter than the per-frame profile this project
 * computes from audio (p50 tonal clarity 0.027 vs 0.043), so the clarity window
 * tuned for the audio pipeline over-penalises it and pushes abstention past 50%.
 * Re-swept here against three sanity targets: abstention under ~40%, major/minor
 * family agreement with Essentia high (we may be MORE specific than it, but must
 * not flip major<->minor), and a plausible Lydian share.
 *
 * NEGATIVE RESULT, kept because it was the whole reason for reading the chord
 * data in the first place: feeding `chords_histogram` in HURTS. Family agreement
 * measured 70.1% with no chord evidence, 55.0% using it for tonic-chord quality,
 * and 53.1% using it as the tonic prior. The most-played chord is too often the
 * dominant or subdominant, and Essentia's chord track is too noisy, for either
 * to locate a tonal centre. The histogram is still STORED — it is real data and
 * may be useful later — but it is not fed to the classifier.
 */
const AB_PARAMS = { CLARITY_FLOOR: 0.012, CLARITY_CEIL: 0.060 };
let seen = 0, inserted = 0, skipped = 0, failed = 0;
const t0 = Date.now();

const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' ').slice(0, 200);

/** Essentia's own answer, mapped into CRATE's vocabulary as the baseline. */
function essentiaBaseline(r: AbRecord): { key: number | null; mode: string | null; name: string | null } {
  if (!r.essentiaKey) return { key: null, mode: null, name: null };
  const flat: Record<string, string> = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#' };
  const k = flat[r.essentiaKey] ?? r.essentiaKey;
  const idx = (PITCH_NAMES as readonly string[]).indexOf(k);
  if (idx < 0) return { key: null, mode: null, name: null };
  return { key: idx, mode: r.essentiaScale ?? null, name: `${PITCH_NAMES[idx]} ${r.essentiaScale ?? ''}`.trim() };
}

function derive(r: AbRecord) {
  // Brightness uses the same log-frequency mapping as the audio pipeline and the
  // same input (spectral centroid in Hz), so it IS comparable across sources.
  const brightness = r.spectralCentroid == null ? null : clamp(
    (Math.log2(Math.max(80, r.spectralCentroid)) - Math.log2(150)) / (Math.log2(5000) - Math.log2(150)), 0, 1);

  // Energy is NOT directly comparable: the audio path uses absolute loudness in
  // dB plus a percussive ratio, neither of which AcousticBrainz publishes. This
  // is a different estimator aiming at the same perceptual quantity, and the
  // distributions are checked against each other after ingestion.
  const energy = clamp(
    0.45 * (r.averageLoudness ?? 0.5) +
    0.30 * clamp((r.onsetRate ?? 0) / 7, 0, 1) +
    0.25 * clamp((r.danceability ?? 0) / 2, 0, 1), 0, 1);

  return { brightness, energy };
}

/**
 * Bulk insert one batch.
 *
 * Written as four multi-row statements rather than four statements per track.
 * The naive per-row version measured 320 tracks/min against Supabase in
 * ap-northeast-2 -- entirely round-trip latency, not work -- which is over five
 * hours for the full dump. Batching collapses 4N round trips into 4.
 */
async function flush(batch: AbRecord[]) {
  if (!batch.length) return;

  const keys = batch.map((r) => `ab:${r.mbid}`);
  const have = new Set(
    (await sql`select source_key from tracks where source_key = any(${keys})`)
      .map((x) => x.source_key as string),
  );
  // AcousticBrainz holds MULTIPLE SUBMISSIONS per recording ({mbid}-0.json,
  // {mbid}-1.json, ...), so one batch can carry the same MBID more than once.
  // Postgres rejects an ON CONFLICT DO UPDATE that touches a row twice in one
  // statement, so collapse to the first submission per MBID here.
  const byMbid = new Map<string, AbRecord>();
  for (const r of batch) if (!byMbid.has(r.mbid)) byMbid.set(r.mbid, r);
  const deduped = [...byMbid.values()];
  const fresh = deduped.filter((r) => !have.has(`ab:${r.mbid}`));
  skipped += batch.length - fresh.length;
  if (!fresh.length) return;

  // ---- 1. artists ---------------------------------------------------------
  const artistRows = Array.from(
    new Map(fresh.map((r) => [norm(r.artist), { source: 'acousticbrainz', source_key: `ab:artist:${norm(r.artist)}`, name: r.artist }])).values(),
  );
  const artistIds = new Map<string, string>();
  for (const row of await sql`
    insert into artists ${sql(artistRows, 'source', 'source_key', 'name')}
    on conflict (source_key) do update set name = excluded.name
    returning id, source_key`) {
    artistIds.set(row.source_key as string, row.id as string);
  }

  // ---- 2. classify, then tracks ------------------------------------------
  const analysed = fresh.map((r) => {
    const hpcp12 = foldHpcp36(r.hpcp36);
    const mode = classifyMode({ hpcp: hpcp12 }, AB_PARAMS);
    const base = essentiaBaseline(r);
    const { brightness, energy } = derive(r);
    const tags = Array.from(new Set([...r.genres, ...r.moods].map((t) => t.toLowerCase()))).slice(0, 16);
    return { r, hpcp12, mode, base, brightness, energy, tags };
  });

  const trackRows = analysed.map(({ r, tags }) => ({
    artist_id: artistIds.get(`ab:artist:${norm(r.artist)}`)!,
    source: 'acousticbrainz',
    source_key: `ab:${r.mbid}`,
    title: r.title,
    album: r.album,
    year: r.year,
    duration_sec: r.durationSec,
    audio_url: null,
    page_url: `https://musicbrainz.org/recording/${r.mbid}`,
    external_url: `https://musicbrainz.org/recording/${r.mbid}`,
    mbid: r.mbid,
    tags,
    analyzed: true,
  }));

  const trackIds = new Map<string, string>();
  for (const row of await sql`
    insert into tracks ${sql(trackRows, 'artist_id', 'source', 'source_key', 'title', 'album',
      'year', 'duration_sec', 'audio_url', 'page_url', 'external_url', 'mbid', 'tags', 'analyzed')}
    on conflict (source_key) do nothing
    returning id, source_key`) {
    trackIds.set(row.source_key as string, row.id as string);
  }

  const landed = analysed.filter((a) => trackIds.has(`ab:${a.r.mbid}`));
  skipped += analysed.length - landed.length;
  if (!landed.length) return;

  // ---- 3. features --------------------------------------------------------
  const featureRows = landed.map(({ r, hpcp12, mode, base, brightness, energy }) => ({
    track_id: trackIds.get(`ab:${r.mbid}`)!,
    hpcp_source: 'acousticbrainz',
    bpm: r.bpm,
    onset_rate: r.onsetRate,
    hpcp: Array.from(hpcp12),
    tonic: mode.tonic,
    tonic_confidence: mode.tonicConfidence,
    mode: mode.mode,
    mode_confidence: mode.modeConfidence,
    mode_scores: sql.json({ ...mode.perMode, tonal_clarity: mode.tonalClarity, top: mode.ranked.slice(0, 5) } as never),
    key_name: mode.keyName,
    flat2_evidence: mode.flat2Evidence,
    baseline_key: base.key,
    baseline_mode: base.mode,
    baseline_key_name: base.name,
    chords_histogram: r.chordsHistogram.length === 24 ? r.chordsHistogram : null,
    chords_key: r.chordsKey,
    chords_scale: r.chordsScale,
    key_strength: r.keyStrength,
    hpcp_entropy: r.hpcpEntropy,
    spectral_centroid: r.spectralCentroid,
    mfcc: r.mfcc.length ? r.mfcc : null,
    instrumental_likelihood: r.voiceInstrumental,
    energy,
    brightness,
    analyzer_version: ANALYZER,
  }));
  await sql`
    insert into audio_features ${sql(featureRows, 'track_id', 'hpcp_source', 'bpm', 'onset_rate',
      'hpcp', 'tonic', 'tonic_confidence', 'mode', 'mode_confidence', 'mode_scores', 'key_name',
      'flat2_evidence', 'baseline_key', 'baseline_mode', 'baseline_key_name', 'chords_histogram',
      'chords_key', 'chords_scale', 'key_strength', 'hpcp_entropy', 'spectral_centroid', 'mfcc',
      'instrumental_likelihood', 'energy', 'brightness', 'analyzer_version')}
    on conflict (track_id) do nothing`;

  // ---- 4. embed FIRST, then insert card and vector in one statement -------
  //
  // The obvious shape -- insert the cards, then UPDATE them with vectors from a
  // VALUES list -- was measured at 32 tracks/min, ten times SLOWER than the
  // naive per-row version it replaced. A 400-row VALUES list of 1536-dim vectors
  // is a ~12 MB inline query string, and Postgres spends all its time parsing it
  // rather than writing. Embedding before the insert removes the UPDATE entirely
  // and lets postgres.js parameterise the vectors properly.
  const cards = landed.map(({ r, mode, brightness, energy }) => ({
    track_id: trackIds.get(`ab:${r.mbid}`)!,
    card: buildAbCard({
      title: r.title, artist: r.artist, album: r.album, year: r.year,
      bpm: r.bpm, keyName: mode.keyName, modeName: mode.mode, tonalClarity: mode.tonalClarity,
      genres: r.genres, moods: r.moods, instrumental: r.voiceInstrumental,
      brightness, energy, danceability: r.danceability, dissonance: r.dissonance,
      dynamicComplexity: r.dynamicComplexity, spectralCentroid: r.spectralCentroid,
      tonalAtonal: r.tonalAtonal,
    }),
  }));

  let embedded = false;
  try {
    const vecs = await embedTexts(cards.map((c) => c.card));
    const rows = cards.map((c, i) => ({ ...c, text_vec: toVector(vecs[i]) }));
    await sql`
      insert into track_embeddings ${sql(rows, 'track_id', 'card', 'text_vec')}
      on conflict (track_id) do update
        set card = excluded.card, text_vec = excluded.text_vec, updated_at = now()`;
    await sql`update tracks set embedded = true where id = any(${cards.map((c) => c.track_id)}::uuid[])`;
    embedded = true;
  } catch (e) {
    console.error('  embedding batch failed:', (e as Error).message.slice(0, 160));
  }
  if (!embedded) {
    // still store the cards so a later pass can embed them
    await sql`
      insert into track_embeddings ${sql(cards, 'track_id', 'card')}
      on conflict (track_id) do update set card = excluded.card`;
  }

  inserted += landed.length;
  const mins = (Date.now() - t0) / 60000;
  console.log(
    `  ${String(inserted).padStart(6)} inserted · ${skipped} skipped · ${failed} failed · ` +
    `${seen} seen · ${mins.toFixed(1)} min · ${(inserted / Math.max(0.01, mins)).toFixed(0)}/min`,
  );
}

async function main() {
  if (!existsSync(LOW_ROOT)) {
    console.error(`low-level dump not found at ${LOW_ROOT}`);
    console.error('extract it first:  zstd -d -c .data/ab-sample.tar.zst | tar -xf - -C .data/extract');
    process.exit(1);
  }
  const highRoot = existsSync(join(HIGH_ROOT, 'highlevel')) ? HIGH_ROOT : null;
  console.log(`AcousticBrainz ingest\n  low:  ${LOW_ROOT}\n  high: ${highRoot ?? '(absent — no genre/mood/voice classifiers)'}\n  limit: ${LIMIT}\n`);

  let batch: AbRecord[] = [];
  for await (const p of walkJson(LOW_ROOT)) {
    if (seen >= LIMIT) break;
    seen++;
    const rec = await parseRecord(p, highRoot);
    if (!rec) { failed++; continue; }
    batch.push(rec);
    if (batch.length >= BATCH) { await flush(batch); batch = []; }
  }
  await flush(batch);

  await sql`
    update artists a set catalog_size = c.n
    from (select artist_id, count(*)::int n from tracks group by artist_id) c
    where c.artist_id = a.id`;

  const [stats] = await sql`select * from corpus_stats`;
  console.log('\n' + '='.repeat(70));
  console.log(`done in ${((Date.now() - t0) / 60000).toFixed(1)} min — inserted ${inserted}, skipped ${skipped}, failed ${failed}`);
  console.log(`corpus: ${stats.tracks_analyzed} analysed / ${stats.tracks_embedded} searchable / ${stats.artists_total} artists`);
  await sql.end();
}

main().catch(async (e) => { console.error(e); await sql.end().catch(() => {}); process.exit(1); });
