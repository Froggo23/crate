import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const sql = db();
    const [stats] = await sql`select * from corpus_stats`;
    const modes = await sql`
      select mode, count(*)::int as n,
             round(avg(mode_confidence)::numeric, 3) as avg_conf
      from audio_features group by mode order by n desc`;
    const bpm = await sql`
      select width_bucket(bpm, 60, 200, 14) as bucket, count(*)::int as n
      from audio_features where bpm between 60 and 200
      group by bucket order by bucket`;
    // Two tiers with very different amounts of information behind them; the
    // corpus page shows the split rather than presenting one blended number.
    const sources = await sql`
      select f.hpcp_source,
             count(*)::int as n,
             round((100.0 * count(*) filter (where f.mode <> 'unclear') / count(*))::numeric, 1) as decided_pct,
             round(avg(f.mode_confidence)::numeric, 3) as avg_conf,
             count(*) filter (where t.audio_url is not null)::int as playable
      from audio_features f join tracks t on t.id = f.track_id
      group by 1 order by n desc`;
    const tags = await sql`
      select lower(t) as tag, count(*)::int as n
      from tracks, unnest(tags) t
      where analyzed group by 1 order by n desc limit 30`;
    return Response.json({ stats, modes, bpm, tags, sources });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
