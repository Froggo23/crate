import { buildEvalReport } from '@/lib/eval';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return Response.json(await buildEvalReport());
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
