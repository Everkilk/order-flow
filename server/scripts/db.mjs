import { connect, databaseUrl, localDatabaseUrl, migrate, quoteIdentifier, reportError } from './db-lib.mjs';

let client;
try {
  const command = process.argv[2];
  if (command === 'create') {
    const url = localDatabaseUrl();
    const name = decodeURIComponent(url.pathname.slice(1));
    if (!name || ['postgres','template0','template1'].includes(name)) throw new Error('Choose an application database name in DATABASE_URL.');
    url.pathname = '/postgres';
    client = await connect(url);
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname=$1', [name]);
    if (exists.rowCount) console.log(`Database already exists: ${name}`);
    else {
      await client.query(`CREATE DATABASE ${quoteIdentifier(name)}`);
      console.log(`Created local database: ${name}`);
    }
  } else {
    client = await connect(databaseUrl());
    if (command === 'migrate') await migrate(client);
    else if (command === 'status') {
      const exists = await client.query("SELECT to_regclass('public.orderflow_schema_migrations') AS name");
      if (!exists.rows[0].name) console.log('No migrations have been applied.');
      else console.table((await client.query('SELECT filename, applied_at FROM public.orderflow_schema_migrations ORDER BY filename')).rows);
    } else throw new Error('Use create, migrate or status.');
  }
} catch (error) { reportError(error); }
finally { if (client) await client.end(); }
