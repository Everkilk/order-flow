import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';

export function databaseUrl() {
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL in server/.env first.');
  return new URL(process.env.DATABASE_URL);
}
export function localDatabaseUrl() {
  const url = databaseUrl();
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)) {
    throw new Error('Database creation and tests require a local PostgreSQL server.');
  }
  return url;
}
export function quoteIdentifier(value) {
  return '"' + value.replaceAll('"', '""') + '"';
}
export async function connect(url = databaseUrl()) {
  const client = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
  try { await client.connect(); } catch (error) { await client.end().catch(() => {}); throw error; }
  return client;
}
export async function migrate(client, log = console.log, through = null) {
  await client.query('SELECT pg_advisory_lock(742019, 2)');
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS public.orderflow_schema_migrations (
      filename text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const directory = new URL('../migrations/', import.meta.url);
    const files = (await readdir(directory)).filter(f => /^\d+_[a-z_]+\.sql$/.test(f)).sort().filter(f => !through || f <= through);
    for (const filename of files) {
      const sql = await readFile(new URL(filename, directory), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const applied = await client.query('SELECT sha256 FROM public.orderflow_schema_migrations WHERE filename=$1', [filename]);
      if (applied.rowCount) {
        if (applied.rows[0].sha256 !== checksum) throw new Error(`Applied migration changed: ${filename}. Add a new migration instead.`);
        log(`Already applied: ${filename}`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO public.orderflow_schema_migrations(filename,sha256) VALUES($1,$2)', [filename, checksum]);
        await client.query('COMMIT');
        log(`Applied: ${filename}`);
      } catch (error) {
        await client.query('ROLLBACK');
        const line = error.position ? sql.slice(0, Number(error.position) - 1).split('\n').length : null;
        error.message = `${filename}${line ? `:${line}` : ''}: ${error.message}${error.where ? ` (${error.where})` : ''}`;
        throw error;
      }
    }
  } finally { await client.query('SELECT pg_advisory_unlock(742019, 2)'); }
}
export function reportError(error) {
  // Deliberately exclude connection objects, URLs and query parameter values.
  const messages = {
    '3D000': 'Database does not exist. Run npm run db:create.',
    '28P01': 'Database login failed. Check server/.env.',
    'ECONNREFUSED': 'PostgreSQL is not accepting connections. Check its service and port.'
  };
  console.error(messages[error.code] ?? `Database command failed${error.code ? ` (${error.code})` : ''}: ${error.message}`);
  process.exitCode = 1;
}
