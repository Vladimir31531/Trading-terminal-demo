import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalMarketStore } from '../server/data/market-store';
import { TIMEFRAMES } from '../src/domain/market';

const HEADER = 'Time,Open,High,Low,Close,Volume';
const temporaryDirectories: string[] = [];
const stores: LocalMarketStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(
  csv = `${HEADER}\n2026-01-01 00:00:00.000+00:00,10,12,9,11,ignored\n`,
) {
  const directory = await mkdtemp(join(tmpdir(), 'terminal-demo-data-test-'));
  temporaryDirectories.push(directory);
  const filePath = join(directory, 'prices.csv');
  const dataDir = join(directory, 'cache');
  await writeFile(filePath, csv);
  const store = new LocalMarketStore({ dataDir });
  stores.push(store);
  return { directory, filePath, dataDir, store, csv };
}

function noProgress(): void {}

describe('local market data', () => {
  test('streams source CSV, caches all nine timeframes and keeps source unchanged', async () => {
    const csv = `${HEADER}\r\n2026-01-31 23:59:00.000+00:00,10,12,9,11,unused\r\n2026-01-31 23:59:01.000+00:00,11,13,10,12,unused\r\n2026-02-01 00:00:00.000+00:00,12,15,11,14,unused\r\n`;
    const { filePath, store, directory, dataDir } = await fixture(csv);
    const instrument = await store.importInstrument(
      { filePath, ticker: ' xau-usd ' },
      noProgress,
    );
    expect(instrument.ticker).toBe('XAU-USD');
    expect(instrument.rowCount).toBe(3);
    expect(store.listInstruments()).toEqual([instrument]);
    for (const timeframe of TIMEFRAMES) {
      const page = await store.loadCandles(instrument.datasetId, timeframe);
      expect(page.hasMore).toBe(false);
      expect(page.candles[0].open).toBe(10);
      expect(page.candles.at(-1)?.close).toBe(14);
      expect(page.candles.some((candle) => 'volume' in candle)).toBe(false);
    }
    expect(
      (await store.loadCandles(instrument.datasetId, '1m')).candles[0],
    ).toEqual({
      time: Date.parse('2026-01-31T23:59:00Z') / 1000,
      open: 10,
      high: 13,
      low: 9,
      close: 12,
    });
    expect(
      (await store.loadCandles(instrument.datasetId, '1W')).candles,
    ).toHaveLength(1);
    expect(
      (await store.loadCandles(instrument.datasetId, '1M')).candles,
    ).toHaveLength(2);
    expect(await readFile(filePath, 'utf8')).toBe(csv);
    expect((await readdir(directory)).sort()).toEqual(['cache', 'prices.csv']);
    const db = new Database(join(dataDir, 'market.sqlite'), { readonly: true });
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM candles WHERE timeframe = '1m'",
        )
        .get()?.count,
    ).toBe(2);
    expect(
      db
        .query<{ name: string }, []>('PRAGMA table_info(datasets)')
        .all()
        .map((column) => column.name),
    ).toEqual(['id', 'sourcePath', 'sourceSize', 'sourceModifiedAt']);
    db.close();
  });

  test('loads latest first and pages backward without duplicates', async () => {
    const rows = Array.from(
      { length: 5 },
      (_, minute) => `2026-01-01 00:0${minute}:00.000+00:00,10,12,9,11,0`,
    );
    const { store, filePath } = await fixture(`${HEADER}\n${rows.join('\n')}`);
    const instrument = await store.importInstrument(
      { filePath, ticker: 'TEST' },
      noProgress,
    );
    const latest = await store.loadCandles(
      instrument.datasetId,
      '1m',
      undefined,
      2,
    );
    const older = await store.loadCandles(
      instrument.datasetId,
      '1m',
      latest.candles[0].time,
      2,
    );
    const earliest = await store.loadCandles(
      instrument.datasetId,
      '1m',
      older.candles[0].time,
      2,
    );
    expect(latest.hasMore).toBe(true);
    expect(latest.hasNewer).toBe(false);
    expect(older.hasMore).toBe(true);
    expect(older.hasNewer).toBe(true);
    expect(earliest.hasMore).toBe(false);
    expect(earliest.hasNewer).toBe(true);
    expect(
      [...earliest.candles, ...older.candles, ...latest.candles].map(
        (candle) => candle.time,
      ),
    ).toEqual(
      rows.map(
        (_, minute) => Date.parse(`2026-01-01T00:0${minute}:00Z`) / 1000,
      ),
    );
    await expect(
      store.loadCandles(instrument.datasetId, '1m', undefined, 0),
    ).rejects.toThrow('Размер страницы');
    await expect(
      store.loadCandles(instrument.datasetId, '1m', Number.NaN),
    ).rejects.toThrow('граница');
    const forward = await store.loadCandles(
      instrument.datasetId,
      '1m',
      undefined,
      2,
      earliest.candles[0].time,
    );
    expect(forward.candles).toEqual(older.candles);
    expect(forward.hasMore).toBe(true);
    expect(forward.hasNewer).toBe(true);
    const newest = await store.loadCandles(
      instrument.datasetId,
      '1m',
      undefined,
      2,
      forward.candles.at(-1)?.time,
    );
    expect(newest.candles).toEqual(latest.candles);
    expect(newest.hasNewer).toBe(false);
    await expect(
      store.loadCandles(instrument.datasetId, '1m', 1, 2, 2),
    ).rejects.toThrow('граница');
  });

  test('retains source price precision even when aggregation removes fractional prices', async () => {
    const { store, filePath, dataDir } = await fixture(
      `${HEADER}\n2026-01-01 00:00:00Z,10,12,9,11,0\n2026-01-01 00:00:01Z,11.001,11.5,10,11.3,0\n2026-01-01 00:00:02Z,11,12,9,11,0`,
    );
    const instrument = await store.importInstrument(
      { filePath, ticker: 'TEST' },
      noProgress,
    );
    expect(instrument.pricePrecision).toBe(3);
    for (const timeframe of TIMEFRAMES) {
      expect(
        (await store.loadCandles(instrument.datasetId, timeframe)).candles[0],
      ).toMatchObject({
        open: 10,
        high: 12,
        low: 9,
        close: 11,
      });
    }
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const restarted = new LocalMarketStore({ dataDir });
    stores.push(restarted);
    expect(restarted.listInstruments()).toEqual([instrument]);
  });

  test('migrates legacy precision from the minute cache once without reading the source CSV', async () => {
    const { store, filePath, dataDir } = await fixture(
      `${HEADER}\n2026-01-01 00:00:00Z,10,12.001,9,11,0`,
    );
    const instrument = await store.importInstrument(
      { filePath, ticker: 'TEST' },
      noProgress,
    );
    store.saveDrawings(instrument.id, '[{"id":"saved"}]');
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const legacy = new Database(join(dataDir, 'market.sqlite'));
    legacy.run('ALTER TABLE instruments DROP COLUMN pricePrecision');
    legacy.close();
    await rm(filePath);

    const migrated = new LocalMarketStore({ dataDir });
    stores.push(migrated);
    expect(migrated.listInstruments()).toEqual([instrument]);
    expect(migrated.loadDrawings(instrument.id)).toBe('[{"id":"saved"}]');
    const db = new Database(join(dataDir, 'market.sqlite'));
    expect(
      db
        .query<{ pricePrecision: number }, []>(
          'SELECT pricePrecision FROM instruments',
        )
        .get()?.pricePrecision,
    ).toBe(3);
    db.run('UPDATE candles SET high = 12');
    expect(migrated.listInstruments()[0].pricePrecision).toBe(3);
    db.close();
    migrated.close();
    stores.splice(stores.indexOf(migrated), 1);
    const restarted = new LocalMarketStore({ dataDir });
    stores.push(restarted);
    expect(restarted.listInstruments()).toEqual([instrument]);
  });

  test('persists instruments and drawings across service restart', async () => {
    const { store, dataDir, filePath } = await fixture();
    const instrument = await store.importInstrument(
      { filePath, ticker: 'TEST' },
      noProgress,
    );
    store.renameInstrument(instrument.id, ' gold ');
    store.saveDrawings(instrument.id, '{"lines":[]}');
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const restarted = new LocalMarketStore({ dataDir });
    stores.push(restarted);
    expect(restarted.listInstruments()[0].ticker).toBe('GOLD');
    expect(restarted.loadDrawings(instrument.id)).toBe('{"lines":[]}');
    expect(
      (await restarted.loadCandles(instrument.datasetId, '1m')).candles,
    ).toHaveLength(1);
  });

  test('deletes only the selected instrument and its cache, preserving its CSV across restart', async () => {
    const { store, dataDir, filePath, csv } = await fixture();
    const removed = await store.importInstrument(
      { filePath, ticker: 'REMOVE' },
      noProgress,
    );
    const retained = await store.importInstrument(
      { filePath, ticker: 'KEEP' },
      noProgress,
    );
    store.saveDrawings(removed.id, '[{"id":"removed"}]');
    store.saveDrawings(retained.id, '[{"id":"retained"}]');

    store.deleteInstrument(removed.id);

    expect(store.listInstruments()).toEqual([retained]);
    expect(() => store.deleteInstrument(removed.id)).toThrow(
      expect.objectContaining({ status: 404 }),
    );
    expect(() => store.loadDrawings(removed.id)).toThrow(
      expect.objectContaining({ status: 404 }),
    );
    await expect(
      store.loadCandles(removed.datasetId, '1m'),
    ).rejects.toMatchObject({
      status: 404,
    });
    const db = new Database(join(dataDir, 'market.sqlite'), { readonly: true });
    for (const table of ['datasets', 'candles']) {
      const column = table === 'datasets' ? 'id' : 'datasetId';
      expect(
        db
          .query<{ count: number }, [string]>(
            `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`,
          )
          .get(removed.datasetId)?.count,
      ).toBe(0);
    }
    expect(
      db
        .query<{ count: number }, [string]>(
          'SELECT COUNT(*) AS count FROM drawings WHERE instrumentId = ?',
        )
        .get(removed.id)?.count,
    ).toBe(0);
    db.close();
    expect(await readFile(filePath, 'utf8')).toBe(csv);
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const restarted = new LocalMarketStore({ dataDir });
    stores.push(restarted);
    expect(restarted.listInstruments()).toEqual([retained]);
    expect(restarted.loadDrawings(retained.id)).toBe('[{"id":"retained"}]');
    expect(
      (await restarted.loadCandles(retained.datasetId, '1m')).candles,
    ).toHaveLength(1);
  });

  test('a replacement import cannot restore an instrument deleted by another connection', async () => {
    const { store, dataDir, filePath } = await fixture();
    const original = await store.importInstrument(
      { filePath, ticker: 'TEST' },
      noProgress,
    );
    const otherConnection = new LocalMarketStore({
      dataDir,
      recoverIncomplete: false,
    });
    stores.push(otherConnection);
    await expect(
      store.importInstrument(
        { filePath, ticker: 'REPLACEMENT', instrumentId: original.id },
        (progress) => {
          if (progress.phase === 'saving')
            otherConnection.deleteInstrument(original.id);
        },
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(store.listInstruments()).toEqual([]);
    const db = new Database(join(dataDir, 'market.sqlite'), { readonly: true });
    for (const table of ['datasets', 'candles']) {
      expect(
        db
          .query<{ count: number }, []>(
            `SELECT COUNT(*) AS count FROM ${table}`,
          )
          .get()?.count,
      ).toBe(0);
    }
    db.close();
  });

  test('replaces a dataset atomically and preserves drawings and instrument identity', async () => {
    const { store, filePath, directory, dataDir } = await fixture();
    const original = await store.importInstrument(
      { filePath, ticker: 'TEST' },
      noProgress,
    );
    store.saveDrawings(original.id, '{}');
    const replacementPath = join(directory, 'new.csv');
    await writeFile(
      replacementPath,
      `${HEADER}\n2026-02-01 00:00:00.000+00:00,20,22.01,19,21,0`,
    );
    const replacement = await store.importInstrument(
      { filePath: replacementPath, ticker: 'NEW', instrumentId: original.id },
      noProgress,
    );
    expect(replacement.id).toBe(original.id);
    expect(replacement.createdAt).toBe(original.createdAt);
    expect(replacement.datasetId).not.toBe(original.datasetId);
    expect(original.pricePrecision).toBe(0);
    expect(replacement.pricePrecision).toBe(2);
    expect(store.listInstruments()).toEqual([replacement]);
    expect(store.loadDrawings(original.id)).toBe('{}');
    await expect(store.loadCandles(original.datasetId, '1m')).rejects.toThrow(
      'больше не существуют',
    );
    expect(
      (await store.loadCandles(replacement.datasetId, '1m')).candles[0].open,
    ).toBe(20);
    const db = new Database(join(dataDir, 'market.sqlite'), { readonly: true });
    expect(
      db
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM datasets')
        .get()?.count,
    ).toBe(1);
    db.close();
  });

  test('failed replacement retains existing data and removes staging cache', async () => {
    const { store, filePath, directory, dataDir } = await fixture();
    const original = await store.importInstrument(
      { filePath, ticker: 'TEST' },
      noProgress,
    );
    const invalid = join(directory, 'invalid.csv');
    await writeFile(
      invalid,
      `${HEADER}\n2026-02-01 00:00:00Z,20,22,19,21,0\n2026-02-01 00:00:00Z,20,22,19,21,0`,
    );
    await expect(
      store.importInstrument(
        { filePath: invalid, ticker: 'NEW', instrumentId: original.id },
        noProgress,
      ),
    ).rejects.toThrow('возрастать');
    expect(store.listInstruments()).toEqual([original]);
    expect(
      (await store.loadCandles(original.datasetId, '1m')).candles,
    ).toHaveLength(1);
    const db = new Database(join(dataDir, 'market.sqlite'), { readonly: true });
    expect(
      db
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM datasets')
        .get()?.count,
    ).toBe(1);
    db.close();
  });

  test('cancellation retains existing data and cleans temporary data', async () => {
    const { store, filePath, dataDir } = await fixture();
    const original = await store.importInstrument(
      { filePath, ticker: 'TEST' },
      noProgress,
    );
    const controller = new AbortController();
    await expect(
      store.importInstrument(
        { filePath, ticker: 'NEW', instrumentId: original.id },
        (progress) => {
          if (progress.rows > 0) controller.abort();
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(store.listInstruments()).toEqual([original]);
    const db = new Database(join(dataDir, 'market.sqlite'), { readonly: true });
    expect(
      db
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM datasets')
        .get()?.count,
    ).toBe(1);
    db.close();
  });

  test('rejects changed or missing source instead of displaying stale candles', async () => {
    const { store, filePath } = await fixture();
    const original = await store.importInstrument(
      { filePath, ticker: 'TEST' },
      noProgress,
    );
    await writeFile(filePath, `${HEADER}\n`);
    await expect(store.loadCandles(original.datasetId, '1m')).rejects.toThrow(
      'изменён',
    );
    await rm(filePath);
    await expect(store.loadCandles(original.datasetId, '1m')).rejects.toThrow(
      'недоступен',
    );
  });

  test('does not activate a source modified during import', async () => {
    const { store, filePath } = await fixture();
    await expect(
      store.importInstrument({ filePath, ticker: 'TEST' }, (progress) => {
        if (progress.rows > 0) writeFileSync(filePath, `${HEADER}\n`);
      }),
    ).rejects.toThrow('изменён');
    expect(store.listInstruments()).toHaveLength(0);
  });

  test('recovers interrupted imports while retaining active datasets', async () => {
    const { store, filePath, dataDir } = await fixture();
    const original = await store.importInstrument(
      { filePath, ticker: 'TEST' },
      noProgress,
    );
    const db = new Database(join(dataDir, 'market.sqlite'));
    db.query('INSERT INTO datasets VALUES (?, ?, ?, ?)').run(
      'interrupted',
      filePath,
      1,
      0,
    );
    db.query('INSERT INTO candles VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      'interrupted',
      '1m',
      1,
      1,
      1,
      1,
      1,
    );
    const workerStore = new LocalMarketStore({
      dataDir,
      recoverIncomplete: false,
    });
    expect(
      db
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM datasets')
        .get()?.count,
    ).toBe(2);
    workerStore.close();
    store.recoverIncompleteImports();
    expect(
      db
        .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM datasets')
        .get()?.count,
    ).toBe(1);
    expect(
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM candles WHERE datasetId = 'interrupted'",
        )
        .get()?.count,
    ).toBe(0);
    expect(
      (await store.loadCandles(original.datasetId, '1m')).candles,
    ).toHaveLength(1);
    db.close();
  });

  test('rejects wrong header, empty data and malformed CSV before activation', async () => {
    const { store, filePath } = await fixture();
    for (const csv of [
      'Time,High,Open,Low,Close,Volume\n',
      `${HEADER}\n`,
      `${HEADER}\n"unterminated`,
    ]) {
      await writeFile(filePath, csv);
      await expect(
        store.importInstrument({ filePath, ticker: 'TEST' }, noProgress),
      ).rejects.toThrow();
      expect(store.listInstruments()).toHaveLength(0);
    }
  });

  test('supports UTF-8 BOM, quotes and CSV records crossing read boundaries', async () => {
    const rows = Array.from({ length: 20000 }, (_, index) => {
      const time = new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
      return `"${time}",10,12,9,11,"unused,volume"`;
    });
    const { store, filePath } = await fixture(
      `\uFEFF${HEADER}\n${rows.join('\n')}`,
    );
    const instrument = await store.importInstrument(
      { filePath, ticker: 'TEST' },
      noProgress,
    );
    expect(instrument.rowCount).toBe(rows.length);
    expect(
      (await store.loadCandles(instrument.datasetId, '1m')).candles,
    ).toHaveLength(334);
  });
});
