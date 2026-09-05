import { NextRequest } from 'next/server';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EVENTS = new Set(['up', 'down', 'play', 'skip', 'save']);

/**
 * Section 2.3: every accept and reject is logged. Over months this becomes a
 * dataset of natural-language music queries paired with human relevance
 * judgements, which does not exist publicly.
 */
export async function POST(request: NextRequest) {
  let body: { queryId?: string; trackId?: string; sessionId?: string; event?: string; position?: number; dwellMs?: number };
  try { body = await request.json(); } catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }); }

  const { queryId, trackId, event } = body;
  if (!trackId || !event || !EVENTS.has(event)) {
    return Response.json({ error: 'trackId and a valid event are required' }, { status: 400 });
  }
  try {
    await db()`
      insert into relevance_events (query_id, track_id, session_id, event, position, dwell_ms)
      values (${queryId ?? null}, ${trackId}, ${(body.sessionId ?? 'anon').slice(0, 64)},
              ${event}, ${body.position ?? null}, ${body.dwellMs ?? null})`;
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
