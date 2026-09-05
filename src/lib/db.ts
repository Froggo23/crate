import postgres from 'postgres';

/**
 * Two connection modes, deliberately:
 *   DATABASE_URL -> Supabase transaction pooler (:6543). Serverless functions
 *                   open and drop connections constantly; the pooler is the only
 *                   thing that survives that. Prepared statements are disabled
 *                   because transaction pooling cannot carry them across.
 *   DIRECT_URL   -> session pooler (:5432), for long-running ingestion where we
 *                   want one durable connection and real prepared statements.
 */
let _app: postgres.Sql | null = null;

export function db(): postgres.Sql {
  if (_app) return _app;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  _app = postgres(url, {
    prepare: false,
    max: 4,
    idle_timeout: 20,
    connect_timeout: 15,
    ssl: 'require',
  });
  return _app;
}

export function directDb(): postgres.Sql {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DIRECT_URL / DATABASE_URL is not set');
  return postgres(url, { prepare: false, max: 6, idle_timeout: 30, connect_timeout: 20, ssl: 'require' });
}

/** pgvector wants '[1,2,3]', not an array literal. */
export function toVector(v: number[]): string {
  return `[${v.join(',')}]`;
}
