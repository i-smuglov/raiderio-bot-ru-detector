import pg from 'pg';

const { Pool } = pg;

export function createPool() {
  // pg reads DATABASE_URL when connectionString is supplied.
  // Railway docs: reference DATABASE_URL from the Postgres service onto the bot service.
  // Bot → Variables → Name: DATABASE_URL  Value: ${{Postgres.DATABASE_URL}}
  // (ServiceName = exact title of your Postgres card on the project canvas, case-sensitive)
  // Template syntax uses NO spaces: ${{Name.VAR}} not ${{ Name.VAR }}

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set on this service.\n' +
        'Railway fix:\n' +
        '  1. Open the Postgres service → Variables → find DATABASE_URL → copy its value.\n' +
        '  2. Open the Bot service → Variables → Add variable.\n' +
        '     Name: DATABASE_URL\n' +
        '     Value (template, no quotes): ${{Postgres.DATABASE_URL}}\n' +
        '     (replace "Postgres" with the exact name shown on the graph card — check Settings > Name)\n' +
        '  3. Redeploy the Bot service.',
    );
  }

  try {
    const host = new URL(connectionString.replace(/^postgresql:\/\//, 'postgres://')).hostname;
    console.log(`[db] PostgreSQL host: ${host}`);
  } catch {
    // malformed URL — pg will give a clearer error at connect time
  }

  return new Pool({ connectionString, max: 3 });
}

/**
 * Node/system error codes that indicate Railway's private network or the
 * Postgres service itself is not yet reachable — these are transient at
 * startup and should be retried just like the Postgres 57P03 code.
 *
 * ENOTFOUND / EAI_AGAIN — DNS not yet resolving (private network initializing)
 * ECONNREFUSED          — TCP port not yet open
 * ECONNRESET            — connection dropped mid-handshake
 * ETIMEDOUT             — connection timed out during startup
 */
const RETRYABLE_NODE_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
]);

/**
 * Returns true when the error is transient and a retry makes sense.
 * @param {any} err
 */
function isRetryable(err) {
  // Postgres "database system is starting up"
  if (err?.code === '57P03') return true;
  // Network / DNS errors that occur before a TCP connection is established
  if (RETRYABLE_NODE_CODES.has(err?.code)) return true;
  return false;
}

/**
 * Retry a SELECT 1 until Postgres accepts connections.
 * Handles:
 *   - 57P03 "the database system is starting up" (Postgres restart)
 *   - DNS / TCP errors while Railway's private network is initializing
 *
 * @param {import('pg').Pool} pool
 * @param {{ maxAttempts?: number; baseDelayMs?: number }} [opts]
 */
export async function waitForDb(pool, { maxAttempts = 20, baseDelayMs = 500 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await pool.query('SELECT 1');
      console.log(`[db] ready (attempt ${attempt})`);
      return;
    } catch (/** @type {any} */ err) {
      if (!isRetryable(err) || attempt === maxAttempts) throw err;
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), 10_000);
      console.warn(
        `[db] not ready (${err.code}), retrying in ${delay}ms (attempt ${attempt}/${maxAttempts})`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
