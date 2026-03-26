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

/**
 * Railway Postgres also exposes PGHOST, PGUSER, etc. If DATABASE_URL reference fails,
 * referencing those vars onto the bot works.
 */
function connectionStringFromPgEnv() {
  const host = process.env.PGHOST?.trim();
  const user = process.env.PGUSER?.trim();
  const password = process.env.PGPASSWORD ?? '';
  const port = (process.env.PGPORT ?? '5432').toString().trim();
  const database = process.env.PGDATABASE?.trim();
  if (!host || !user || !database) return null;
  const ssl =
    process.env.PGSSLMODE === 'require' || process.env.PGSSLMODE === 'prefer'
      ? `?sslmode=${process.env.PGSSLMODE}`
      : '';
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(database)}${ssl}`;
}

function resolveConnectionString() {
  const raw = process.env.DATABASE_URL?.trim();

  if (raw && (raw.includes('${{') || raw.includes('{{'))) {
    throw new Error(
      [
        'DATABASE_URL is still a literal template (Railway did not substitute it).',
        'In the BOT Variables value field use only: ${{ postgres.DATABASE_URL }} — no surrounding quotes, no DATABASE_URL= prefix.',
        'Replace postgres with your Postgres service name exactly as on the canvas (try Postgres if postgres fails).',
        'Or reference PGHOST, PGUSER, PGPASSWORD, PGPORT, PGDATABASE from Postgres to this service (app will build the URL).',
      ].join(' '),
    );
  }

  if (raw) return raw;

  const built = connectionStringFromPgEnv();
  if (built) {
    console.log('[db] using connection built from PGHOST/PGUSER/PGDATABASE/PGPASSWORD/PGPORT');
    return built;
  }

  throw new Error(
    [
      'Missing DATABASE_URL (and no PGHOST/PGUSER/PGDATABASE on this service).',
      'Railway: open the BOT service → Variables → New variable → DATABASE_URL.',
      'Value must be only: ${{ postgres.DATABASE_URL }} (service name matches your Postgres service).',
      'Do not paste shell syntax like DATABASE_URL="..." ; only the value inside quotes belongs in Railway.',
      'Ensure the variable is on the same environment as the running deploy (e.g. production).',
    ].join(' '),
  );
}

export function createPool() {
  const connectionString = resolveConnectionString();

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
        'Railway: Bot → Variables → remove wrong DATABASE_URL. Add DATABASE_URL = ${{ YourPostgresServiceName.DATABASE_URL }}',
        '(type that template manually if "reference" has no suggestions; name must match Postgres service on the canvas). Redeploy.',
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
