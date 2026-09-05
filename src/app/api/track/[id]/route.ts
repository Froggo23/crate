import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Next 16: route params are a Promise and must be awaited.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return Response.json({ error: 'invalid track id' }, { status: 400 });
  }
  try {
    const rows = await db()`
      select
        t.*, a.name as artist_name, a.emergence_percentile, a.listenbrainz_listens,
        a.mbid as artist_mbid, a.catalog_size, a.deezer_fans,
        row_to_json(f.*) as features, te.card
      from tracks t
      join artists a on a.id = t.artist_id
      left join audio_features f on f.track_id = t.id
      left join track_embeddings te on te.track_id = t.id
      where t.id = ${id}`;
    if (!rows.length) return Response.json({ error: 'not found' }, { status: 404 });
    return Response.json(rows[0]);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
