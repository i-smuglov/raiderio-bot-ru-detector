import pg from 'pg';

const { Pool } = pg;

export function createPool() {
  // pg reads DATABASE_URL when connectionString is supplied.
  // Neon / Supabase / Railway: set DATABASE_URL on the process that runs the bot (not committed to git).

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set.\n' +
        'Set it in your host\'s environment (e.g. Fly.io secrets, Render env, Railway variables, or local .env):\n' +
        '  Name: DATABASE_URL\n' +
        '  Value: your Postgres URL (Neon dashboard → Connection string; include sslmode=require if the provider shows it).',
    );
  }

  try {
    const host = new URL(connectionString.replace(/^postgresql:\/\//, 'postgres://')).hostname;
    console.log(`[db] PostgreSQL host: ${host}`);
  } catch {
    // malformed URL — pg will give a clearer error at connect time
  }

  const max = Math.max(1, Math.min(20, Number(process.env.PG_POOL_MAX ?? '3')));
  return new Pool({ connectionString, max });
}
