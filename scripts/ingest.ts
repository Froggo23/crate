/**
 * CRATE corpus ingestion.
 *
 *   npx tsx scripts/ingest.ts --target 2500 --concurrency 8
 *
 * Resumable by design: the archive.org scrape cursor lives in `ingest_state`,
 * every track is keyed by a stable `source_key`, and a crash costs at most the
 * batch in flight. Re-running continues from where it stopped rather than
 * re-analysing what is already in the database -- which matters, because the
 * expensive step is bandwidth, not CPU.
 *
 * Per track: fetch a 60 s excerpt -> full DSP analysis -> generate an audio card
 * -> embed the card -> write features + vectors. Failures are recorded on the
 * track row and skipped, never fatal.
 */

import './env';
import { directDb, toVector } from '../src/lib/db';
import { scrapePage, itemTracks, TrackCandidate, ScrapeItem } from '../src/lib/sources/archive';
import { analyzeUrl, ANALYZER_VERSION } from '../src/lib/dsp/analyze';
import { buildCard } from '../src/lib/card';
import { embedTexts } from '../src/lib/embed';
import { pool, USER_AGENT } from '../src/lib/net';

const args = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const TARGET = parseInt(arg('target', '2500'), 10);
const CONCURRENCY = parseInt(arg('concurrency', '8'), 10);
const QUERY = arg('query', 'collection:netlabels AND mediatype:audio');
const CURSOR_KEY = `archive_cursor:${QUERY}`;
const MAX_PER_ITEM = parseInt(arg('per-item', '3'), 10);

const sql = directDb();
const t0 = Date.now();
let analyzed = 0, skipped = 0, failed = 0, discovered = 0;

const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' ').slice(0, 200);

async function getState<T>(key: string): Promise<T | null> {
  const r = await sql`select value from ingest_state where key = ${key}`;
  return r.length ? (r[0].value as T) : null;
}
async function setState(key: string, value: unknown) {
  await sql`
    insert into ingest_state (key, value, updated_at) values (${key}, ${sql.json(value as never)}, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
}

async function upsertArtist(name: string): Promise<string> {
  const key = `archive:artist:${norm(name)}`;
  const r = await sql`
    insert into artists (source, source_key, name)
    values ('archive', ${key}, ${name})
    on conflict (source_key) do update set name = excluded.name
    returning id`;
  return r[0].id as string;
}

/** Which of these source keys do we already have? */
async function existing(keys: string[]): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const r = await sql`select source_key from tracks where source_key = any(${keys})`;
  return new Set(r.map((x) => x.source_key as string));
}

async function processTrack(c: TrackCandidate): Promise<'ok' | 'fail'> {
  let trackId: string | null = null;
  try {
    const artistId = await upsertArtist(c.artistName);
    const ins = await sql`
      insert into tracks (
        artist_id, source, source_key, title, album, year, duration_sec,
        audio_url, page_url, license_url, license_short, artwork_url, tags
      ) values (
        ${artistId}, 'archive', ${c.sourceKey}, ${c.title}, ${c.album}, ${c.year}, ${c.durationSec},
        ${c.audioUrl}, ${c.pageUrl}, ${c.licenseUrl}, ${c.licenseShort}, ${c.artworkUrl}, ${c.tags}
      )
      on conflict (source_key) do nothing
      returning id`;
    if (!ins.length) { skipped++; return 'ok'; }
    trackId = ins[0].id as string;

    const a = await analyzeUrl(c.audioUrl, {
      userAgent: USER_AGENT,
      knownDurationSec: c.durationSec,
      timeoutMs: 120_000,
    });

    await sql`
      insert into audio_features (
        track_id, bpm, bpm_confidence, onset_rate, beat_strength,
        hpcp, hpcp_bass, hpcp_downbeat, hpcp_phrase_final, tonic, tonic_confidence,
        mode, mode_confidence, mode_scores, key_name, flat2_evidence,
        baseline_key, baseline_mode, baseline_key_name, baseline_correlation,
        rms, loudness_db, crest_factor, dynamic_range_db,
        spectral_centroid, spectral_rolloff, spectral_flatness, spectral_bandwidth,
        spectral_flux, zcr, hf_ratio, lf_ratio, percussive_ratio, mfcc,
        instrumental_likelihood, energy, brightness, analyzer_version
      ) values (
        ${trackId}, ${a.tempo.bpm}, ${a.tempo.bpmConfidence}, ${a.tempo.onsetRate}, ${a.tempo.beatStrength},
        ${a.hpcp}, ${a.hpcpBass}, ${a.hpcpDownbeat}, ${a.hpcpPhraseFinal}, ${a.mode.tonic}, ${a.mode.tonicConfidence},
        ${a.mode.mode}, ${a.mode.modeConfidence},
        ${sql.json({ ...a.mode.perMode, tonal_clarity: a.mode.tonalClarity, top: a.mode.ranked.slice(0, 5) } as never)},
        ${a.mode.keyName}, ${a.mode.flat2Evidence},
        ${a.baseline.key}, ${a.baseline.mode}, ${a.baseline.keyName}, ${a.baseline.correlation},
        ${a.dynamics.rms}, ${a.dynamics.loudnessDb}, ${a.dynamics.crestFactor}, ${a.dynamics.dynamicRangeDb},
        ${a.spectral.spectralCentroid}, ${a.spectral.spectralRolloff}, ${a.spectral.spectralFlatness},
        ${a.spectral.spectralBandwidth}, ${a.spectral.spectralFlux}, ${a.dynamics.zcr},
        ${a.spectral.hfRatio}, ${a.spectral.lfRatio}, ${a.spectral.percussiveRatio}, ${a.spectral.mfcc},
        ${a.instrumentalLikelihood}, ${a.energy}, ${a.brightness}, ${ANALYZER_VERSION}
      )
      on conflict (track_id) do nothing`;

    const card = buildCard({
      title: c.title, artist: c.artistName, album: c.album, year: c.year, tags: c.tags, analysis: a,
    });
    await sql`update tracks set analyzed = true, analysis_error = null where id = ${trackId}`;
    await sql`
      insert into track_embeddings (track_id, descriptor_vec, card)
      values (${trackId}, ${toVector(a.descriptorVector)}, ${card})
      on conflict (track_id) do update set descriptor_vec = excluded.descriptor_vec, card = excluded.card`;

    analyzed++;
    const tag = a.mode.mode === 'unclear' ? 'unclear' : a.mode.keyName;
    process.stdout.write(
      `  [${String(analyzed).padStart(4)}] ${c.artistName.slice(0, 22).padEnd(22)} ` +
      `${c.title.slice(0, 30).padEnd(30)} ${a.tempo.bpm.toFixed(0).padStart(3)}bpm ` +
      `${tag.padEnd(20)} conf ${a.mode.modeConfidence.toFixed(2)}\n`,
    );
    return 'ok';
  } catch (e) {
    failed++;
    const msg = (e as Error).message.slice(0, 400);
    if (trackId) {
      await sql`update tracks set analysis_error = ${msg} where id = ${trackId}`.catch(() => {});
    }
    process.stdout.write(`  [fail] ${c.title.slice(0, 42).padEnd(42)} ${msg.slice(0, 70)}\n`);
    return 'fail';
  }
}

/** Embed every analysed track that still has no text vector. */
async function embedPending(limit = 400): Promise<number> {
  const rows = await sql`
    select te.track_id, te.card
    from track_embeddings te
    join tracks t on t.id = te.track_id
    where te.text_vec is null and te.card is not null and t.analyzed
    limit ${limit}`;
  if (!rows.length) return 0;
  const vecs = await embedTexts(rows.map((r) => r.card as string));
  for (let i = 0; i < rows.length; i++) {
    await sql`
      update track_embeddings set text_vec = ${toVector(vecs[i])}, updated_at = now()
      where track_id = ${rows[i].track_id}`;
    await sql`update tracks set embedded = true where id = ${rows[i].track_id}`;
  }
  return rows.length;
}

async function main() {
  const startCount = Number((await sql`select count(*)::int as n from tracks where analyzed`)[0].n);
  console.log(`CRATE ingest — target ${TARGET} analysed tracks (have ${startCount})`);
  console.log(`query: ${QUERY}\nconcurrency: ${CONCURRENCY}\n`);

  let cursor = (await getState<{ cursor: string | null }>(CURSOR_KEY))?.cursor ?? null;
  let rounds = 0;

  while (startCount + analyzed < TARGET) {
    rounds++;
    const page = await scrapePage(cursor, 300, QUERY);
    if (!page.items.length) { console.log('\ncollection exhausted'); break; }
    discovered += page.items.length;

    // expand items -> track candidates (metadata calls, cheap and parallel)
    const nested = await pool(page.items, 6, async (it: ScrapeItem) => {
      try { return await itemTracks(it, MAX_PER_ITEM); } catch { return []; }
    });
    let cands = nested.flat();

    const have = await existing(cands.map((c) => c.sourceKey));
    cands = cands.filter((c) => !have.has(c.sourceKey));
    // cap the batch so the cursor is saved often
    const remaining = TARGET - (startCount + analyzed);
    cands = cands.slice(0, Math.max(0, Math.min(cands.length, remaining + 40)));

    console.log(
      `\n-- round ${rounds}: ${page.items.length} items -> ${cands.length} new candidates ` +
      `(have ${startCount + analyzed}/${TARGET}, ${((Date.now() - t0) / 60000).toFixed(1)} min elapsed)`,
    );

    // Process in chunks and embed after each one. A whole round can be 500+
    // candidates, and embedding only at the end leaves everything analysed in
    // that round unsearchable for ~25 minutes -- `crate_search` requires
    // `embedded`, so the live corpus visibly lags the ingested one.
    const CHUNK = 60;
    for (let i = 0; i < cands.length; i += CHUNK) {
      await pool(cands.slice(i, i + CHUNK), CONCURRENCY, (c) => processTrack(c));
      const n = await embedPending();
      if (n) console.log(`  embedded ${n} cards  (${startCount + analyzed}/${TARGET})`);
    }

    cursor = page.cursor;
    await setState(CURSOR_KEY, { cursor, updatedAt: new Date().toISOString() });
    if (!cursor) { console.log('\nno further cursor — collection exhausted'); break; }
  }

  // any stragglers
  for (;;) { const n = await embedPending(); if (!n) break; console.log(`  embedded ${n} cards`); }

  // catalog size feeds the emergence score
  await sql`
    update artists a set catalog_size = c.n
    from (select artist_id, count(*)::int n from tracks group by artist_id) c
    where c.artist_id = a.id`;
  await sql`
    update artists a set first_release_year = c.y
    from (select artist_id, min(year) y from tracks where year is not null group by artist_id) c
    where c.artist_id = a.id and a.first_release_year is null`;

  const stats = (await sql`select * from corpus_stats`)[0];
  console.log('\n' + '='.repeat(70));
  console.log(`done in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  console.log(`analysed ${analyzed}  skipped ${skipped}  failed ${failed}  discovered ${discovered} items`);
  console.log(`corpus: ${stats.tracks_analyzed} analysed / ${stats.tracks_embedded} embedded / ` +
              `${stats.artists_total} artists / ${stats.mode_decided_pct}% mode decided`);
  await sql.end();
}

main().catch(async (e) => { console.error(e); await sql.end().catch(() => {}); process.exit(1); });
