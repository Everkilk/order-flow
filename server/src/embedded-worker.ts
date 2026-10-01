import type pg from 'pg';
import type { Config } from './config.js';
import { logger } from './errors.js';
import { runOneJob } from './job-worker.js';

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}

export async function runEmbeddedWorker(pool: pg.Pool, config: Config, signal: AbortSignal): Promise<void> {
  logger.info('Embedded job worker started');
  while (!signal.aborted) {
    try {
      const worked = await runOneJob(pool, config);
      if (!worked) await wait(5000, signal);
    } catch (error) {
      logger.error({ err: error }, 'Embedded job worker failed; retrying');
      await wait(5000, signal);
    }
  }
}
