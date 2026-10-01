import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { publishFile, prepareWrite, withLocalFile, storedFileExists, openStoredStream, removeStoredFile } from '../dist/storage.js';

test('S3-backed files round-trip and temporary copies are cleaned up', async () => {
  const objects = new Map();
  const server = createServer(async (req, res) => {
    const key = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/test\.bucket\//, '');
    if (req.method === 'PUT') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      objects.set(key, Buffer.concat(chunks));
      res.writeHead(200, { ETag: '"test-etag"' }).end();
      return;
    }
    if (req.method === 'DELETE') {
      objects.delete(key);
      res.writeHead(204).end();
      return;
    }
    const body = objects.get(key);
    if (!body) {
      res.writeHead(404, { 'Content-Type': 'application/xml' });
      res.end(req.method === 'HEAD' ? undefined : '<Error><Code>NoSuchKey</Code><Message>Missing</Message></Error>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Length': String(body.length) });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const directory = await mkdtemp(join(tmpdir(), 'orderflow-storage-'));
  const key = `imports/${randomUUID()}.csv`;
  const old = {
    endpoint: process.env.AWS_ENDPOINT_URL_S3,
    access: process.env.AWS_ACCESS_KEY_ID,
    secret: process.env.AWS_SECRET_ACCESS_KEY,
  };
  process.env.AWS_ENDPOINT_URL_S3 = `http://127.0.0.1:${server.address().port}`;
  process.env.AWS_ACCESS_KEY_ID = 'test';
  process.env.AWS_SECRET_ACCESS_KEY = 'test';
  const config = { DATA_DIR: directory, STORAGE_DRIVER: 's3', S3_BUCKET: 'test.bucket', AWS_REGION: 'us-east-1' };
  try {
    const path = await prepareWrite(config, key);
    await writeFile(path, 'sku,name\nA-1,Example\n');
    await publishFile(config, key);
    assert.equal(objects.get(key)?.toString(), 'sku,name\nA-1,Example\n');
    assert.equal((await readdir(join(directory, 'imports'))).length, 0);
    assert.equal(await storedFileExists(config, key), true);
    await withLocalFile(config, key, async localPath => {
      assert.equal((await readFile(localPath, 'utf8')), 'sku,name\nA-1,Example\n');
    });
    assert.equal((await readdir(join(directory, 'imports'))).length, 0);
    objects.set(key, Buffer.from('sku,name\nB-2,Changed\n'));
    await withLocalFile(config, key, async localPath => {
      assert.equal((await readFile(localPath, 'utf8')), 'sku,name\nB-2,Changed\n');
    });
    assert.equal((await readdir(join(directory, 'imports'))).length, 0);
    const chunks = [];
    for await (const chunk of await openStoredStream(config, key)) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'sku,name\nB-2,Changed\n');
    await removeStoredFile(config, key);
    assert.equal(await storedFileExists(config, key), false);
    await assert.rejects(withLocalFile(config, key, async () => {}), { code: 'ENOENT' });
  } finally {
    if (old.endpoint === undefined) delete process.env.AWS_ENDPOINT_URL_S3;
    else process.env.AWS_ENDPOINT_URL_S3 = old.endpoint;
    if (old.access === undefined) delete process.env.AWS_ACCESS_KEY_ID;
    else process.env.AWS_ACCESS_KEY_ID = old.access;
    if (old.secret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = old.secret;
    await rm(directory, { recursive: true, force: true });
    server.close();
    await once(server, 'close');
  }
});
