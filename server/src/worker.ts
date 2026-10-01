import { readConfig } from './config.js';
import { makePool } from './db.js';
import { logger } from './errors.js';
import { runOneJob } from './job-worker.js';

const config=readConfig();
const pool=makePool(config);
let stopping=false;
process.once('SIGINT',()=>{stopping=true;});
process.once('SIGTERM',()=>{stopping=true;});

try {
  do {
    const worked=await runOneJob(pool,config);
    if (process.argv.includes('--once')) break;
    if (!worked) await new Promise(resolve=>setTimeout(resolve,2000));
  } while (!stopping);
} catch(error) {
  logger.fatal({err:error},'worker stopped');
  process.exitCode=1;
} finally {await pool.end();}
