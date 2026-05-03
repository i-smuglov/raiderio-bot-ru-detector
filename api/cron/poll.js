import { getServerlessAppContext, handleCronPoll } from '../../src/httpDispatch.js';

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }
  try {
    const { pool, rest } = getServerlessAppContext();
    await handleCronPoll(pool, rest, req, res);
  } catch (e) {
    console.error('[api/cron/poll]', e);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('error');
    }
  }
}
