import { readConfig } from './config.js';
import { makePool } from './db.js';
import { createApp } from './app.js';
import { logger } from './errors.js';
import { runEmbeddedWorker } from './embedded-worker.js';

const config = readConfig();
const pool = makePool(config);
const shutdownController = new AbortController();
const server = createApp(pool, config, shutdownController.signal).listen(config.PORT, config.HOST, () => {
  logger.info({ port: config.PORT, host: config.HOST }, 'OrderFlow API listening');
});
const workerDone = config.EMBEDDED_WORKER
  ? runEmbeddedWorker(pool, config, shutdownController.signal)
  : undefined;

async function shutdown() {
  shutdownController.abort();
  server.close(async () => {
    if (workerDone) await workerDone;
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
