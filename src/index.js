import http from 'node:http';
import {
  createLocalAppContext,
  dispatchHttp,
  sendText,
} from './httpDispatch.js';

function startServer() {
  const ctx = createLocalAppContext();
  const { pool } = ctx;

  const port = process.env.PORT ?? '8080';
  const server = http.createServer(async (req, res) => {
    try {
      await dispatchHttp(req, res, ctx);
    } catch (e) {
      console.error('[http]', e);
      sendText(res, 500, 'error');
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
