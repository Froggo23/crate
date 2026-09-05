/**
 * Artist enrichment + emergence scoring.
 *
 *   npx tsx scripts/enrich.ts [--limit 500]
 *
 * Resolves each artist against MusicBrainz, pulls open listen counts from
 * ListenBrainz and a second popularity signal from Deezer, derives net-label
 * catalogue size, then recomputes the emergence percentiles that power the
 * "emerging artists only" constraint.
 *
 * Artists that cannot be resolved keep a null percentile and are treated as
 * PASSING an obscurity ceiling rather than failing it -- an unknown artist is
 * almost certainly obscure, and excluding them would defeat the purpose.
 */

import './env';
import { directDb } from '../src/lib/db';
import { lookupMusicBrainz, listenBrainzPopularity, lookupDeezer } from '../src/lib/sources/metadata';
import { pool } from '../src/lib/net';

const args = process.argv.slice(2);
const LIMIT = Number(args[args.indexOf('--limit') + 1]) || 400;
const sql = directDb();

async function main() {
  const artists = await sql`
    select id, name from artists
    where enriched_at is null
    order by created_at
    limit ${LIMIT}`;
  console.log(`enriching ${artists.length} artists\n`);

  let mbHits = 0, dzHits = 0;
  const mbidByArtist = new Map<string, string>();

  // MusicBrainz is rate-limited to 1 req/s, so concurrency here buys nothing;
  // Deezer runs alongside it inside the same task.
  await pool(artists, 3, async (a) => {
    const name = a.name as string;
    if (!name || name.toLowerCase() === 'unknown artist') {
      await sql`update artists set enriched_at = now() where id = ${a.id}`;
      return;
    }
    const [mb, dz] = await Promise.all([
      lookupMusicBrainz(name).catch(() => null),
      lookupDeezer(name).catch(() => null),
    ]);
    if (mb) { mbHits++; mbidByArtist.set(a.id as string, mb.mbid); }
    if (dz) dzHits++;

    await sql`
      update artists set
        mbid = ${mb?.mbid ?? null},
        mb_country = ${mb?.country ?? null},
        mb_type = ${mb?.type ?? null},
        mb_begin_year = ${mb?.beginYear ?? null},
        deezer_id = ${dz?.id ?? null},
        deezer_fans = ${dz?.fans ?? null},
        enriched_at = now()
      where id = ${a.id}`;
    process.stdout.write(
      `  ${name.slice(0, 34).padEnd(34)} mb:${mb ? 'yes' : ' - '}  dz:${dz ? String(dz.fans).padStart(8) : '       -'}\n`,
    );
  });

  // ListenBrainz in bulk, keyed by the MBIDs we just resolved
  const mbids = Array.from(new Set(mbidByArtist.values()));
  console.log(`\nfetching ListenBrainz counts for ${mbids.length} MBIDs…`);
  const pops = await listenBrainzPopularity(mbids);
  const byMbid = new Map(pops.map((p) => [p.mbid, p]));
  let lbHits = 0;
  for (const [artistId, mbid] of mbidByArtist) {
    const p = byMbid.get(mbid);
    if (!p) continue;
    lbHits++;
    await sql`
      update artists set listenbrainz_listens = ${p.listens}, listenbrainz_listeners = ${p.listeners}
      where id = ${artistId}`;
  }

  // Net-label size, derived from the archive.org identifier prefix. Releases on
  // the same net label share a stub ("hc040", "hc041" -> "hc"), so this is a
  // usable proxy for label reach without a Discogs token. Heuristic, and labelled
  // as one in the README.
  await sql`
    with labels as (
      select regexp_replace(split_part(source_key, ':', 2), '[0-9_\\-].*$', '') as stub,
             artist_id
      from tracks where source = 'archive'
    ),
    sizes as (
      select stub, count(distinct artist_id)::int n from labels where stub <> '' group by stub
    )
    update artists a set
      label = l.stub,
      label_size = s.n
    from labels l join sizes s on s.stub = l.stub
    where l.artist_id = a.id`;

  await sql`
    update artists a set catalog_size = c.n
    from (select artist_id, count(*)::int n from tracks group by artist_id) c
    where c.artist_id = a.id`;

  const [{ refresh_emergence: n }] = await sql`select refresh_emergence()`;
  const dist = await sql`
    select
      count(*) filter (where emergence_percentile <= 20)::int as emerging,
      count(*) filter (where listenbrainz_listens > 0)::int as with_listens,
      round(max(listenbrainz_listens)::numeric, 0) as max_listens,
      count(*)::int as total
    from artists`;

  console.log(`\n${'='.repeat(64)}`);
  console.log(`MusicBrainz resolved ${mbHits}/${artists.length} · Deezer ${dzHits} · ListenBrainz ${lbHits}`);
  console.log(`emergence recomputed for ${n} artists`);
  console.log(`in the bottom 20th popularity percentile: ${dist[0].emerging}/${dist[0].total}`);
  console.log(`artists with any listen data: ${dist[0].with_listens} (max ${dist[0].max_listens} listens)`);
  await sql.end();
}

main().catch(async (e) => { console.error(e); await sql.end().catch(() => {}); process.exit(1); });
