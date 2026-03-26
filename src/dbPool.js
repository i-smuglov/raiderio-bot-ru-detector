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

/** True when this process runs on Railway (NODE_ENV is not always set to "production"). */
function isLikelyRailwayRuntime() {
  return Boolean(
    process.env.RAILWAY_ENVIRONMENT ||
      process.env.RAILWAY_PROJECT_ID ||
      process.env.RAILWAY_SERVICE_ID,
  );
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

  const forbidLocalDb =
    process.env.NODE_ENV === 'production' ||
    isLikelyRailwayRuntime() ||
    process.env.FORBID_LOCAL_DATABASE_URL === '1';

  if (loopback && forbidLocalDb) {
    throw new Error(
      [
        `DATABASE_URL uses host "${host}" — Postgres is not on this container.`,
        'Fix (Railway): open your BOT service → Variables → remove any manually-entered DATABASE_URL.',
        'Click "New variable" → "Variable reference" → select your Postgres service → DATABASE_URL.',
        'Save, then Redeploy. The host should look like *.railway.internal (never localhost).',
      ].join(' '),
    );
  }

  if (!loopback) {
    console.log(`[db] connecting to PostgreSQL host: ${host}`);
  }

  return new Pool({
    connectionString,
    max: 3,
    idleTimeoutMillis: 30_000,
  });
}
