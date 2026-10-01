import { hash } from '@node-rs/argon2';
import { connect, databaseUrl } from './db-lib.mjs';

async function readPassword() {
  if (!process.stdin.isTTY) {
    let value = '';
    for await (const chunk of process.stdin) value += chunk;
    return value.trimEnd();
  }
  process.stdout.write('Initial manager password (input hidden): ');
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const done = (error) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      process.stdout.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onData = (key) => {
      if (key === '\r' || key === '\n') return done();
      if (key === '\u0003') return done(new Error('Setup cancelled.'));
      if (key === '\u007f' || key === '\b') value = value.slice(0,-1);
      else if (/^[^\x00-\x1f]+$/.test(key)) value += key;
    };
    process.stdin.on('data', onData);
  });
}

let client;
try {
  const email = process.argv[2];
  const displayName = process.argv[3] || 'Initial manager';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Usage: npm run setup:admin -- manager@example.com "Manager name"');
  databaseUrl();
  client = await connect();
  const current = await client.query('SELECT count(*)::int AS count FROM orderflow.users');
  if (current.rows[0].count !== 0) throw new Error('Users already exist; create additional accounts through the manager API.');
  const password = await readPassword();
  if (password.length < 12) throw new Error('Password must contain at least 12 characters.');
  const passwordHash = await hash(password, { memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(742019,3)');
  const stillEmpty = await client.query('SELECT count(*)::int AS count FROM orderflow.users');
  if (stillEmpty.rows[0].count !== 0) throw new Error('Another account was created during setup.');
  await client.query('INSERT INTO orderflow.users(email,display_name,password_hash,role,must_change_password) VALUES($1,$2,$3,$4,false)',
    [email,displayName,passwordHash,'MANAGER']);
  await client.query('COMMIT');
  console.log('Initial manager created.');
} catch (error) {
  if (client) await client.query('ROLLBACK').catch(() => {});
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (client) await client.end();
}
