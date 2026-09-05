import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Nightly recompute of the emergence percentiles (Vercel Cron). */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get('authorization');
  if (secret && auth !== `Bearer ${secret}`) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const sql = db();
    await sql`
      update artists a set catalog_size = c.n
      from (select artist_id, count(*)::int n from tracks group by artist_id) c
      where c.artist_id = a.id`;
    const [{ refresh_emergence: updated }] = await sql`select refresh_emergence()`;
    return Response.json({ ok: true, artistsUpdated: updated });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
