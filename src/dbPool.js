import pg from 'pg';

const { Pool } = pg;

export function createPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('Missing DATABASE_URL');
  }
  return new Pool({
    connectionString,
    max: 3,
    idleTimeoutMillis: 30_000,
  });
}
