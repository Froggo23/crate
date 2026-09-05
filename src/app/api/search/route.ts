import { NextRequest } from 'next/server';
import { runSearch } from '@/lib/search';
import { db } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  let body: { q?: string; sessionId?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const q = (body.q ?? '').trim();
  const sessionId = (body.sessionId ?? 'anon').slice(0, 64);
  if (!q) return Response.json({ error: 'q is required' }, { status: 400 });
  if (q.length > 500) return Response.json({ error: 'query too long (max 500 chars)' }, { status: 400 });

  // Postgres-backed rate limiting. No Redis dependency: one fewer service to
  // provision, and the limit survives cold starts because it lives in the DB.
  try {
    const ok = await db()`select bump_rate_limit(${'search:' + sessionId}, 30, 60) as ok`;
    if (!ok[0].ok) {
      return Response.json({ error: 'rate limited — 30 searches per minute' }, { status: 429 });
    }
  } catch (e) {
    console.error('[search] rate limit check failed, allowing:', (e as Error).message);
  }

  try {
    const result = await runSearch(q, sessionId);
    return Response.json(result);
  } catch (e) {
    console.error('[search] failed:', e);
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
