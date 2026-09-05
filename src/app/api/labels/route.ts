import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { MODE_NAMES, PITCH_NAMES } from '@/lib/llm/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The hand-labelling endpoint.
 *
 * Plan, Phase 1: "Build a hand-labelled evaluation set of 200 tracks across
 * modes. This is tedious and it is the most valuable thing you will make."
 * Building it into the app rather than a spreadsheet means the labeller hears
 * the exact excerpt the classifier analysed, and the label lands next to the
 * prediction it will be scored against.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('mode');
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? 12)));
  try {
    // Prefer tracks the classifier is LEAST sure about — those are where a human
    // label carries the most information.
    const rows = await db()`
      select t.id, t.title, t.audio_url, t.duration_sec, t.tags, a.name as artist_name,
             f.bpm, f.tonic, f.mode, f.mode_confidence, f.key_name,
             f.baseline_key_name, f.hpcp, f.mode_scores
      from tracks t
      join artists a on a.id = t.artist_id
      join audio_features f on f.track_id = t.id
      left join mode_labels ml on ml.track_id = t.id
      where t.analyzed and ml.track_id is null
        and (${mode}::text is null or f.mode = ${mode})
      order by abs(coalesce(f.mode_confidence, 0) - 0.5) asc, random()
      limit ${limit}`;
    const [counts] = await db()`
      select count(*)::int as labelled,
             (select count(distinct labeled_mode)::int from mode_labels) as modes_covered
      from mode_labels`;
    return Response.json({ tracks: rows, counts });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  let body: { trackId?: string; tonic?: string; mode?: string; labeler?: string; confidence?: number; notes?: string };
  try { body = await request.json(); } catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }); }

  const { trackId, tonic, mode } = body;
  if (!trackId) return Response.json({ error: 'trackId required' }, { status: 400 });
  const tonicIdx = PITCH_NAMES.indexOf(tonic as (typeof PITCH_NAMES)[number]);
  if (tonicIdx < 0) return Response.json({ error: 'tonic must be a pitch class name' }, { status: 400 });
  if (!mode || !(MODE_NAMES as readonly string[]).includes(mode)) {
    return Response.json({ error: 'mode must be one of ' + MODE_NAMES.join(', ') }, { status: 400 });
  }
  try {
    await db()`
      insert into mode_labels (track_id, labeled_tonic, labeled_mode, labeler, confidence, notes)
      values (${trackId}, ${tonicIdx}, ${mode}, ${(body.labeler ?? 'anon').slice(0, 60)},
              ${Math.min(5, Math.max(1, body.confidence ?? 3))}, ${body.notes ?? null})
      on conflict (track_id) do update set
        labeled_tonic = excluded.labeled_tonic,
        labeled_mode = excluded.labeled_mode,
        labeler = excluded.labeler,
        confidence = excluded.confidence,
        notes = excluded.notes`;
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
