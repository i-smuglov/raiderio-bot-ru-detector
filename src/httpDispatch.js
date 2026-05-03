import getRawBody from 'raw-body';
import { verifyKey } from 'discord-interactions';
import { InteractionResponseType, MessageFlags, REST } from 'discord.js';
import { createPool } from './dbPool.js';
import { GuildStore } from './guildStore.js';
import { buildInteractionResponse } from './interactionRouter.js';
import { pollFeedChannels } from './pollFeeds.js';

const LOG_LEVEL = (process.env.LOG_LEVEL ?? 'info').toLowerCase();

/**
 * Raw bytes as sent by Discord (required for Ed25519 verify). Uses stream read.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Buffer>}
 */
export async function readDiscordInteractionBody(req) {
  const len = req.headers['content-length'];
  return getRawBody(req, {
    encoding: false,
    limit: 6 * 1024 * 1024,
    ...(len ? { length: parseInt(String(len), 10) } : {}),
  });
}

/**
 * @param {import('node:http').IncomingMessage} req
 */
export function authorizeCron(req) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const auth = req.headers.authorization;
  if (auth === `Bearer ${secret}`) return true;
  const h = req.headers['x-cron-secret'];
  return typeof h === 'string' && h === secret;
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} code
 * @param {string} body
 */
export function sendText(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {unknown} payload
 */
export function sendJson(res, payload) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

/**
 * @param {import('pg').Pool} pool
 * @param {REST} rest
 * @param {string} publicKey
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export async function handleInteractionsPost(pool, rest, publicKey, req, res) {
  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];
  if (typeof signature !== 'string' || typeof timestamp !== 'string') {
    return sendText(res, 401, 'invalid signature headers');
  }

  const rawBody = await readDiscordInteractionBody(req);
  const ok = verifyKey(rawBody, signature, timestamp, publicKey);
  if (!ok) {
    return sendText(res, 401, 'invalid signature');
  }

  /** @type {import('discord.js').APIInteraction} */
  const interaction = JSON.parse(rawBody.toString('utf8'));
  const store = new GuildStore(pool);
  const out = await buildInteractionResponse(rest, interaction, store);

  if ('deferEphemeral' in out && out.deferEphemeral) {
    sendJson(res, {
      type: InteractionResponseType.DeferredChannelMessageWithSource,
      data: { flags: MessageFlags.Ephemeral },
    });
    await out.then();
    return;
  }

  sendJson(res, out.json);
}

/**
 * @param {import('pg').Pool} pool
 * @param {REST} rest
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export async function handleCronPoll(pool, rest, req, res) {
  if (!authorizeCron(req)) {
    return sendText(res, 401, 'unauthorized');
  }
  const store = new GuildStore(pool);
  const summary = await pollFeedChannels(rest, store);
  if (LOG_LEVEL === 'debug') console.log('[cron/poll]', summary);
  sendJson(res, { ok: true, ...summary });
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ pool: import('pg').Pool; rest: REST; publicKey: string }} ctx
 */
export async function dispatchHttp(req, res, ctx) {
  const { pool, rest, publicKey } = ctx;
  const host = req.headers.host ?? 'localhost';
  const url = new URL(req.url ?? '/', `http://${host}`);

  if (req.method === 'GET' && url.pathname === '/') {
    return sendText(res, 200, 'ok');
  }

  if (req.method === 'POST' && url.pathname === '/interactions') {
    return handleInteractionsPost(pool, rest, publicKey, req, res);
  }

  if ((req.method === 'POST' || req.method === 'GET') && url.pathname === '/cron/poll') {
    return handleCronPoll(pool, rest, req, res);
  }

  sendText(res, 404, 'not found');
}

/**
 * Bootstraps pool + REST for long-running `node src/index.js`.
 *
 * @returns {{ pool: import('pg').Pool; rest: REST; publicKey: string }}
 */
export function createLocalAppContext() {
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
  return { pool, rest, publicKey };
}

/** @type {{ pool: import('pg').Pool; rest: REST; publicKey: string } | undefined} */
let serverlessCtx;

/**
 * One shared pool per serverless isolate (Vercel `api/*`).
 *
 * @returns {{ pool: import('pg').Pool; rest: REST; publicKey: string }}
 */
export function getServerlessAppContext() {
  if (!serverlessCtx) serverlessCtx = createLocalAppContext();
  return serverlessCtx;
}
