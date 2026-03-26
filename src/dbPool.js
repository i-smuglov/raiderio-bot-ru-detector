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
