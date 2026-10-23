import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createApplication } from '../server/application';
import type { ServiceConfig } from '../server/config';
import { probeExistingService } from '../server/main';
import type {
  ImportEvent,
  ServiceIdentity,
} from '../src/application/service-contract';
import type {
  DirectoryListing,
  HistoryPage,
  Instrument,
} from '../src/domain/market';

const CSV =
  'Time,Open,High,Low,Close,Volume\n2026-01-01 00:00:00.000+00:00,10,12,9,11,0\n2026-01-01 00:00:01.000+00:00,11,13,10,12,0\n2026-01-01 00:01:00.000+00:00,12,14,10,11,0\n';
const identity: ServiceIdentity = {
  app: 'terminal-demo',
  projectId: 'test-project',
  mode: 'start',
  protocolVersion: 1,
  ready: true,
};
let directory: string;
let config: ServiceConfig;
let application: ReturnType<typeof createApplication>;
let token: string;

function call(path: string, options: RequestInit = {}) {
  return application.fetch(
    new Request(`http://127.0.0.1:3000${path}`, {
      ...options,
      headers: { 'X-Terminal-Token': token, ...options.headers },
    }),
  );
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'terminal-service-api-'));
  const sources = join(directory, 'sources');
  await mkdir(sources);
  await mkdir(join(directory, 'dist'));
  await writeFile(join(directory, 'dist/index.html'), '<html>Terminal</html>');
  await writeFile(join(directory, 'private.txt'), 'private-sentinel');
  await writeFile(join(sources, 'prices.csv'), CSV);
  await writeFile(join(sources, 'other.txt'), 'not a CSV');
  config = {
    projectRoot: directory,
    dataDir: join(directory, 'state'),
    projectId: identity.projectId,
    dataDirectories: [sources],
    port: 3000,
    devPort: 3001,
  };
  application = createApplication(config, identity);
  token = ((await (await call('/api/session')).json()) as { token: string })
    .token;
});

afterEach(async () => {
  await application.close();
  if (
    dirname(resolve(directory)) !== resolve(tmpdir()) ||
    !basename(directory).startsWith('terminal-service-api-')
  )
    throw new Error('Unexpected cleanup target');
  await rm(directory, { recursive: true, force: true });
});

describe('development proxy', () => {
  test('keeps protocol-relative-looking paths on the local development server', async () => {
    let forwardedUrl: string | undefined;
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        forwardedUrl = request.url;
        return new Response('local-development-asset');
      },
    });
    try {
      await application.close();
      application = createApplication(config, identity, upstream.url.origin);
      const response = await call('//example.com/asset.js?version=1');
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('local-development-asset');
      const forwarded = new URL(forwardedUrl ?? '');
      expect(forwarded.origin).toBe(upstream.url.origin);
      expect(forwarded.search).toBe('?version=1');
    } finally {
      await upstream.stop(true);
    }
  });

  test('preserves compressed asset bytes with their content encoding', async () => {
    const encoded = Bun.gzipSync('console.log("development asset");');
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () =>
        new Response(encoded, {
          headers: {
            'Content-Type': 'application/javascript',
            'Content-Encoding': 'gzip',
          },
        }),
    });
    try {
      await application.close();
      application = createApplication(config, identity, upstream.url.origin);
      const response = await call('/static/asset.js');
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Encoding')).toBe('gzip');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(encoded);
    } finally {
      await upstream.stop(true);
    }
  });
});

describe('local service boundaries', () => {
  test('requires a session token and rejects foreign origins and hostnames', async () => {
    expect(
      (await call('/api/instruments', { headers: { 'X-Terminal-Token': '' } }))
        .status,
    ).toBe(401);
    expect(
      (
        await call('/api/session', {
          headers: { Origin: 'https://example.com' },
        })
      ).status,
    ).toBe(403);
    expect(
      (await call('/api/session', { headers: { Origin: 'null' } })).status,
    ).toBe(403);
    expect(
      (await call('/api/session', { headers: { Host: 'example.com:3000' } }))
        .status,
    ).toBe(403);
    expect(
      (
        await call('/api/session', {
          headers: { Origin: 'http://127.0.0.1:3000' },
        })
      ).status,
    ).toBe(200);
  });

  test('exposes only selected roots and CSV file IDs', async () => {
    const listing = (await (
      await call('/api/files')
    ).json()) as DirectoryListing;
    expect(listing.entries.map((entry) => entry.name)).toEqual(['prices.csv']);
    expect((await call('/api/files?directoryId=../../')).status).toBe(404);
    const denied = await call('/api/imports', {
      method: 'POST',
      body: JSON.stringify({
        ticker: 'X',
        sourceId: join(directory, 'private.txt'),
      }),
    });
    expect(denied.status).toBe(404);
    const traversal = await call('/static/..%2f..%2fprivate.txt');
    expect(traversal.status).toBe(404);
    expect(await traversal.text()).not.toContain('private-sentinel');
  });

  test('validates pagination, JSON and drawing requests', async () => {
    expect((await call('/api/candles?datasetId=x&timeframe=1s')).status).toBe(
      400,
    );
    expect(
      (await call('/api/candles?datasetId=x&timeframe=1m&limit=2001')).status,
    ).toBe(400);
    expect(
      (await call('/api/candles?datasetId=x&timeframe=1m&before=1&after=2'))
        .status,
    ).toBe(400);
    for (const path of [
      '/api/candles?datasetId=x&timeframe=1m&asOf=bad',
      '/api/seconds?datasetId=x',
      '/api/seconds?datasetId=x&from=0&through=bad',
      '/api/seconds?datasetId=x&from=2&through=1',
      '/api/seconds?datasetId=x&from=0&through=1&limit=5001',
    ])
      expect((await call(path)).status).toBe(400);
    expect(
      (await call('/api/imports', { method: 'POST', body: '[' })).status,
    ).toBe(400);
    expect(
      (
        await call('/api/drawings/x', {
          method: 'PUT',
          body: JSON.stringify({ json: '{}' }),
        })
      ).status,
    ).toBe(400);
  });
});

test('imports a disk source in a worker and serves metadata, pages and drawings', async () => {
  const listing = (await (await call('/api/files')).json()) as DirectoryListing;
  const response = await call('/api/imports', {
    method: 'POST',
    body: JSON.stringify({
      sourceId: listing.entries[0].id,
      ticker: ' xau-usd ',
    }),
  });
  expect(response.status).toBe(200);
  const events = (await response.text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as ImportEvent);
  const completed = events.find((event) => event.type === 'complete');
  expect(completed?.type).toBe('complete');
  if (completed?.type !== 'complete') throw new Error(JSON.stringify(events));
  const instrument = completed.instrument;
  expect(instrument.ticker).toBe('XAU-USD');
  expect(instrument.rowCount).toBe(3);
  const page = (await (
    await call(
      `/api/candles?datasetId=${instrument.datasetId}&timeframe=1m&limit=1`,
    )
  ).json()) as HistoryPage;
  expect(page.candles[0].close).toBe(11);
  expect(page.hasMore).toBe(true);
  expect(page.hasNewer).toBe(false);
  const seconds = (await (
    await call(
      `/api/seconds?datasetId=${instrument.datasetId}&from=${instrument.firstTime}&through=${instrument.lastTime}&limit=2`,
    )
  ).json()) as HistoryPage;
  expect(seconds.candles.map((candle) => candle.close)).toEqual([11, 12]);
  expect(seconds.hasMore).toBe(true);
  const snapshot = (await (
    await call(
      `/api/candles?datasetId=${instrument.datasetId}&timeframe=1H&asOf=${instrument.firstTime}`,
    )
  ).json()) as HistoryPage;
  expect(snapshot.candles).toEqual([
    { time: instrument.firstTime, open: 10, high: 12, low: 9, close: 11 },
  ]);
  expect(snapshot.hasNewer).toBe(false);
  await call(`/api/instruments/${instrument.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ ticker: 'GOLD' }),
  });
  await call(`/api/drawings/${instrument.id}`, {
    method: 'PUT',
    body: JSON.stringify({ json: '[]' }),
  });
  expect(await (await call(`/api/drawings/${instrument.id}`)).json()).toEqual({
    json: '[]',
  });
  const items = (await (await call('/api/instruments')).json()) as Instrument[];
  expect(items[0].ticker).toBe('GOLD');
  expect(await readFile(join(directory, 'sources/prices.csv'), 'utf8')).toBe(
    CSV,
  );
});

test('deletes an instrument only with authentication and persists removal without changing its source', async () => {
  const listing = (await (await call('/api/files')).json()) as DirectoryListing;
  const imported = await call('/api/imports', {
    method: 'POST',
    body: JSON.stringify({ sourceId: listing.entries[0].id, ticker: 'DELETE' }),
  });
  const events = (await imported.text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as ImportEvent);
  const completed = events.find((event) => event.type === 'complete');
  if (completed?.type !== 'complete') throw new Error(JSON.stringify(events));
  const instrument = completed.instrument;
  await call(`/api/drawings/${instrument.id}`, {
    method: 'PUT',
    body: JSON.stringify({ json: '[]' }),
  });
  expect(
    (
      await call(`/api/instruments/${instrument.id}`, {
        method: 'DELETE',
        headers: { 'X-Terminal-Token': '' },
      })
    ).status,
  ).toBe(401);
  expect(await (await call('/api/instruments')).json()).toEqual([instrument]);

  const deleted = await call(`/api/instruments/${instrument.id}`, {
    method: 'DELETE',
  });
  expect(deleted.status).toBe(204);
  expect(await deleted.text()).toBe('');
  expect(await (await call('/api/instruments')).json()).toEqual([]);
  expect((await call(`/api/drawings/${instrument.id}`)).status).toBe(404);
  expect(
    (await call(`/api/candles?datasetId=${instrument.datasetId}&timeframe=1m`))
      .status,
  ).toBe(404);
  expect(
    (await call(`/api/instruments/${instrument.id}`, { method: 'DELETE' }))
      .status,
  ).toBe(404);
  await application.close();
  application = createApplication(config, identity);
  token = ((await (await call('/api/session')).json()) as { token: string })
    .token;
  expect(await (await call('/api/instruments')).json()).toEqual([]);
  expect(await readFile(join(directory, 'sources/prices.csv'), 'utf8')).toBe(
    CSV,
  );
});

test('recognizes only a matching project instance on an occupied port', async () => {
  let served: unknown = identity;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => Response.json(served),
  });
  try {
    expect(
      (await probeExistingService(server.url.origin, identity.projectId))
        ?.ready,
    ).toBe(true);
    expect(
      await probeExistingService(server.url.origin, 'another-project'),
    ).toBeUndefined();
    served = { ...identity, ready: false };
    expect(
      (await probeExistingService(server.url.origin, identity.projectId))
        ?.ready,
    ).toBe(false);
    served = { message: 'another application' };
    expect(
      await probeExistingService(server.url.origin, identity.projectId),
    ).toBeUndefined();
  } finally {
    await server.stop(true);
  }
});
