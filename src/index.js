import http from 'node:http';
import { REST, InteractionResponseType, MessageFlags } from 'discord.js';
import { verifyKey } from 'discord-interactions';
import { createPool } from './dbPool.js';
import { GuildStore } from './guildStore.js';
import { buildInteractionResponse } from './interactionRouter.js';
import { pollFeedChannels } from './pollFeeds.js';

const LOG_LEVEL = (process.env.LOG_LEVEL ?? 'info').toLowerCase();

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Buffer>}
 */
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} code
 * @param {string} body
 */
function text(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {unknown} json
 */
function json(res, json) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(json));
}

/**
 * @param {import('node:http').IncomingMessage} req
 */
function authorizeCron(req) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const auth = req.headers.authorization;
  if (auth === `Bearer ${secret}`) return true;
  const h = req.headers['x-cron-secret'];
  return typeof h === 'string' && h === secret;
}

function startServer() {
  const token = process.env.DISCORD_TOKEN ?? '';
  if (!token) {
    throw new Error('Missing DISCORD_TOKEN');
  }

  const publicKey = process.env.DISCORD_PUBLIC_KEY?.trim() ?? '';
  if (!publicKey) {
    throw new Error('Missing DISCORD_PUBLIC_KEY (Discord Application → General → Public Key)');
  }

  const pool = createPool();
  pool.on('error', (err) => {
    console.warn(`[db] pool error: ${err instanceof Error ? err.message : String(err)}`);
  });

  const rest = new REST({ version: '10' }).setToken(token);

  const port = process.env.PORT ?? '8080';
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      if (req.method === 'GET' && url.pathname === '/') {
        return text(res, 200, 'ok');
      }

      if (req.method === 'POST' && url.pathname === '/interactions') {
        const signature = req.headers['x-signature-ed25519'];
        const timestamp = req.headers['x-signature-timestamp'];
        if (typeof signature !== 'string' || typeof timestamp !== 'string') {
          return text(res, 401, 'invalid signature headers');
        }

        const rawBody = await readRawBody(req);
        const ok = verifyKey(rawBody, signature, timestamp, publicKey);
        if (!ok) {
          return text(res, 401, 'invalid signature');
        }

        /** @type {import('discord.js').APIInteraction} */
        const interaction = JSON.parse(rawBody.toString('utf8'));
        const store = new GuildStore(pool);
        const out = await buildInteractionResponse(rest, interaction, store);

        if ('deferEphemeral' in out && out.deferEphemeral) {
          json(res, {
            type: InteractionResponseType.DeferredChannelMessageWithSource,
            data: { flags: MessageFlags.Ephemeral },
          });
          await out.then();
          return;
        }

        json(res, out.json);
        return;
      }

      if ((req.method === 'POST' || req.method === 'GET') && url.pathname === '/cron/poll') {
        if (!authorizeCron(req)) {
          return text(res, 401, 'unauthorized');
        }
        const store = new GuildStore(pool);
        const summary = await pollFeedChannels(rest, store);
        if (LOG_LEVEL === 'debug') console.log('[cron/poll]', summary);
        json(res, { ok: true, ...summary });
        return;
      }

      text(res, 404, 'not found');
    } catch (e) {
      console.error('[http]', e);
      text(res, 500, 'error');
    }
  });

  server.on('error', (err) => {
    console.error('[http] failed to bind:', err);
    process.exit(1);
  });

  server.listen(Number(port), '0.0.0.0', () => {
    console.log(`[http] listening on 0.0.0.0:${port}`);
    console.log('[http] routes: GET /, POST /interactions, POST|GET /cron/poll');
  });

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  /**
   * @param {string} signal
   */
  async function shutdown(signal) {
    console.log(`${signal} received, closing DB pool`);
    await pool.end().catch(() => {});
    process.exit(0);
  }
}

try {
  startServer();
} catch (e) {
  console.error('[boot] startup failed:', e);
  process.exit(1);
}
