import pg from 'pg';

const { Pool } = pg;

/**
 * @param {string} connectionString
 */
function pgUrlHostname(connectionString) {
  try {
    const u = new URL(
      connectionString.replace(/^postgresql:\/\//i, 'postgres://'),
    );
    return u.hostname;
  } catch {
    return '';
  }
}

export function createPool() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error('Missing DATABASE_URL');
  }

  const host = pgUrlHostname(connectionString);
  const loopback =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host === '::1';

  if (loopback && process.env.NODE_ENV === 'production') {
    throw new Error(
      'DATABASE_URL points to localhost—there is no Postgres inside the bot container. On Railway: open the bot service → Variables → ensure DATABASE_URL is a Reference to the Postgres plugin (hostname like *.railway.internal), not a local URL.',
    );
  }

  return new Pool({
    connectionString,
    max: 3,
    idleTimeoutMillis: 30_000,
  });
}
