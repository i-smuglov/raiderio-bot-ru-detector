import pg from 'pg';

const { Pool } = pg;

export function createPool(): pg.Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('Missing DATABASE_URL');
  }
  return new Pool({
    connectionString,
    max: 10,
  });
}
