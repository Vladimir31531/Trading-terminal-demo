import { Database } from 'bun:sqlite';
import { createReadStream, mkdirSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import Papa from 'papaparse';
import {
  type AggregatedCandle,
  CandleAggregator,
} from '../../src/domain/aggregation';
import {
  normalizeTicker,
  parseCsvCandle,
  validateCsvFile,
  validateCsvHeader,
} from '../../src/domain/csv-validation';
import {
  type Candle,
  type HistoryPage,
  type ImportProgress,
  type Instrument,
  TIMEFRAMES,
  type Timeframe,
} from '../../src/domain/market';
import { pricePrecision } from '../../src/domain/price-precision';

const READ_CHUNK_BYTES = 1024 * 1024;
const MAX_PAGE_SIZE = 5000;
const INSTRUMENT_COLUMNS =
  'id, ticker, datasetId, fileName, fileSize, rowCount, firstTime, lastTime, createdAt, pricePrecision';

export class MarketDataError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'MarketDataError';
  }
}

function validate<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    throw new MarketDataError(
      error instanceof Error ? error.message : 'Некорректные данные CSV.',
    );
  }
}

export interface DiskImportInput {
  filePath: string;
  ticker: string;
  instrumentId?: string;
}

export interface LocalMarketStoreOptions {
  dataDir: string;
  /** Only the owning service performs recovery, before starting import workers. */
  recoverIncomplete?: boolean;
}

interface SourceRecord {
  sourcePath: string;
  sourceSize: number;
  sourceModifiedAt: number;
}

interface ImportStats {
  rowCount: number;
  firstTime: number;
  lastTime: number;
  pricePrecision: number;
}

function candlePricePrecision(
  candle: Pick<Candle, 'open' | 'high' | 'low' | 'close'>,
): number {
  return Math.max(
    pricePrecision(candle.open),
    pricePrecision(candle.high),
    pricePrecision(candle.low),
    pricePrecision(candle.close),
  );
}

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Импорт отменён.', 'AbortError');
}

async function assertSourceUnchanged(source: SourceRecord): Promise<void> {
  let current: Awaited<ReturnType<typeof stat>>;
  try {
    current = await stat(source.sourcePath);
  } catch {
    throw new MarketDataError(
      'Исходный CSV недоступен. Выберите файл заново в настройках инструмента.',
      409,
    );
  }
  if (
    !current.isFile() ||
    current.size !== source.sourceSize ||
    current.mtimeMs !== source.sourceModifiedAt
  ) {
    throw new MarketDataError(
      'Исходный CSV изменён. Подключите обновлённый файл в настройках инструмента.',
      409,
    );
  }
}

/** Disk-backed candle cache. The original CSV is never copied into the database. */
export class LocalMarketStore {
  private readonly db: Database;

  constructor({ dataDir, recoverIncomplete = true }: LocalMarketStoreOptions) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(join(dataDir, 'market.sqlite'), {
      create: true,
      strict: true,
    });
    this.db.run(`
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS datasets (
        id TEXT PRIMARY KEY,
        sourcePath TEXT NOT NULL,
        sourceSize INTEGER NOT NULL,
        sourceModifiedAt REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS instruments (
        id TEXT PRIMARY KEY,
        ticker TEXT NOT NULL,
        datasetId TEXT NOT NULL UNIQUE REFERENCES datasets(id),
        fileName TEXT NOT NULL,
        fileSize INTEGER NOT NULL,
        rowCount INTEGER NOT NULL,
        firstTime REAL NOT NULL,
        lastTime REAL NOT NULL,
        createdAt INTEGER NOT NULL,
        pricePrecision INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS candles (
        datasetId TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
        timeframe TEXT NOT NULL,
        time REAL NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        PRIMARY KEY (datasetId, timeframe, time)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS drawings (
        instrumentId TEXT PRIMARY KEY REFERENCES instruments(id) ON DELETE CASCADE,
        json TEXT NOT NULL
      );
    `);
    const columns = this.db
      .query<{ name: string }, []>('PRAGMA table_info(instruments)')
      .all();
    if (!columns.some((column) => column.name === 'pricePrecision')) {
      this.db.run('ALTER TABLE instruments ADD COLUMN pricePrecision INTEGER');
    }
    if (recoverIncomplete) this.recoverIncompleteImports();
  }

  close(): void {
    this.db.close();
  }

  /** Call only after all import workers have stopped. */
  recoverIncompleteImports(): void {
    this.db.run(
      'DELETE FROM datasets WHERE id NOT IN (SELECT datasetId FROM instruments)',
    );
  }

  listInstruments(): Instrument[] {
    this.backfillPricePrecision();
    return this.db
      .query<Instrument, []>(
        `SELECT ${INSTRUMENT_COLUMNS} FROM instruments ORDER BY createdAt, id`,
      )
      .all();
  }

  private backfillPricePrecision(): void {
    const instruments = this.db
      .query<Pick<Instrument, 'id' | 'datasetId'>, []>(
        'SELECT id, datasetId FROM instruments WHERE pricePrecision IS NULL',
      )
      .all();
    if (!instruments.length) return;
    const candles = this.db.query<
      Pick<Candle, 'open' | 'high' | 'low' | 'close'>,
      [string]
    >(
      "SELECT open, high, low, close FROM candles WHERE datasetId = ? AND timeframe = '1m'",
    );
    const update = this.db.query(
      'UPDATE instruments SET pricePrecision = ? WHERE id = ? AND datasetId = ? AND pricePrecision IS NULL',
    );
    for (const instrument of instruments) {
      let precision = 0;
      for (const candle of candles.iterate(instrument.datasetId)) {
        precision = Math.max(precision, candlePricePrecision(candle));
        if (precision === 8) break;
      }
      update.run(precision, instrument.id, instrument.datasetId);
    }
  }

  renameInstrument(id: string, ticker: string): void {
    const updated = this.db
      .query('UPDATE instruments SET ticker = ? WHERE id = ?')
      .run(
        validate(() => normalizeTicker(ticker)),
        id,
      );
    if (!updated.changes)
      throw new MarketDataError('Инструмент больше не существует.', 404);
  }

  deleteInstrument(id: string): void {
    this.db
      .transaction(() => {
        const instrument = this.instrument(id);
        this.db.query('DELETE FROM instruments WHERE id = ?').run(id);
        this.db
          .query('DELETE FROM datasets WHERE id = ?')
          .run(instrument.datasetId);
      })
      .immediate();
  }

  async importInstrument(
    input: DiskImportInput,
    onProgress: (progress: ImportProgress) => void,
    signal?: AbortSignal,
  ): Promise<Instrument> {
    assertNotCancelled(signal);
    const ticker = validate(() => normalizeTicker(input.ticker));
    if (!isAbsolute(input.filePath))
      throw new MarketDataError('Нужен абсолютный путь к CSV-файлу.');
    let sourcePath: string;
    let sourceStat: Awaited<ReturnType<typeof stat>>;
    try {
      sourcePath = await realpath(input.filePath);
      sourceStat = await stat(sourcePath);
    } catch {
      throw new MarketDataError('Не удалось открыть выбранный CSV-файл.', 409);
    }
    if (!sourceStat.isFile()) throw new MarketDataError('Выберите CSV-файл.');
    validate(() =>
      validateCsvFile({ name: basename(sourcePath), size: sourceStat.size }),
    );
    const existing = input.instrumentId
      ? this.instrument(input.instrumentId)
      : undefined;
    const source: SourceRecord = {
      sourcePath,
      sourceSize: sourceStat.size,
      sourceModifiedAt: sourceStat.mtimeMs,
    };
    const datasetId = crypto.randomUUID();
    this.db
      .query('INSERT INTO datasets VALUES (?, ?, ?, ?)')
      .run(
        datasetId,
        source.sourcePath,
        source.sourceSize,
        source.sourceModifiedAt,
      );

    try {
      onProgress({ percent: 0, rows: 0, phase: 'reading' });
      const stats = await this.parseFile(source, datasetId, onProgress, signal);
      await assertSourceUnchanged(source);
      assertNotCancelled(signal);
      onProgress({ percent: 99, rows: stats.rowCount, phase: 'saving' });
      assertNotCancelled(signal);
      const instrument: Instrument = {
        id: existing?.id ?? crypto.randomUUID(),
        ticker,
        datasetId,
        fileName: basename(sourcePath),
        fileSize: source.sourceSize,
        ...stats,
        createdAt: existing?.createdAt ?? Date.now(),
      };
      this.db.transaction(() => {
        if (
          existing &&
          this.instrument(existing.id).datasetId !== existing.datasetId
        ) {
          throw new MarketDataError(
            'Данные инструмента уже заменены другим импортом.',
            409,
          );
        }
        this.db
          .query(`
          INSERT INTO instruments (${INSTRUMENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET ticker=excluded.ticker, datasetId=excluded.datasetId,
            fileName=excluded.fileName, fileSize=excluded.fileSize, rowCount=excluded.rowCount,
            firstTime=excluded.firstTime, lastTime=excluded.lastTime,
            pricePrecision=excluded.pricePrecision
        `)
          .run(
            instrument.id,
            instrument.ticker,
            instrument.datasetId,
            instrument.fileName,
            instrument.fileSize,
            instrument.rowCount,
            instrument.firstTime,
            instrument.lastTime,
            instrument.createdAt,
            stats.pricePrecision,
          );
        if (existing)
          this.db
            .query('DELETE FROM datasets WHERE id = ?')
            .run(existing.datasetId);
      })();
      return instrument;
    } catch (error) {
      this.db.query('DELETE FROM datasets WHERE id = ?').run(datasetId);
      throw error;
    }
  }

  async loadCandles(
    datasetId: string,
    timeframe: Timeframe,
    before?: number,
    limit = 800,
    after?: number,
  ): Promise<HistoryPage> {
    if (!TIMEFRAMES.includes(timeframe))
      throw new MarketDataError('Неизвестный таймфрейм.');
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new MarketDataError(
        `Размер страницы должен быть от 1 до ${MAX_PAGE_SIZE}.`,
      );
    }
    if (
      (before !== undefined && !Number.isFinite(before)) ||
      (after !== undefined && !Number.isFinite(after)) ||
      (before !== undefined && after !== undefined)
    )
      throw new MarketDataError('Некорректная граница истории.');
    const source = this.db
      .query<SourceRecord, [string]>(`
      SELECT sourcePath, sourceSize, sourceModifiedAt FROM datasets
      WHERE id = ? AND EXISTS (SELECT 1 FROM instruments WHERE datasetId = datasets.id)
    `)
      .get(datasetId);
    if (!source)
      throw new MarketDataError(
        'Данные инструмента больше не существуют.',
        404,
      );
    await assertSourceUnchanged(source);
    const rows =
      after !== undefined
        ? this.db
            .query<Candle, [string, string, number, number]>(`
          SELECT time, open, high, low, close FROM candles
          WHERE datasetId = ? AND timeframe = ? AND time > ? ORDER BY time ASC LIMIT ?
        `)
            .all(datasetId, timeframe, after, limit)
        : before === undefined
          ? this.db
              .query<Candle, [string, string, number]>(`
          SELECT time, open, high, low, close FROM candles
          WHERE datasetId = ? AND timeframe = ? ORDER BY time DESC LIMIT ?
        `)
              .all(datasetId, timeframe, limit)
          : this.db
              .query<Candle, [string, string, number, number]>(`
          SELECT time, open, high, low, close FROM candles
          WHERE datasetId = ? AND timeframe = ? AND time < ? ORDER BY time DESC LIMIT ?
        `)
              .all(datasetId, timeframe, before, limit);
    const candles = after === undefined ? rows.reverse() : rows;
    const first = candles[0]?.time ?? after ?? before;
    const last = candles.at(-1)?.time ?? before ?? after;
    const hasMore =
      first !== undefined &&
      this.db
        .query<{ found: number }, [string, string, number]>(`
      SELECT 1 AS found FROM candles WHERE datasetId = ? AND timeframe = ? AND time < ? LIMIT 1
    `)
        .get(datasetId, timeframe, first) !== null;
    const hasNewer =
      last !== undefined &&
      this.db
        .query<{ found: number }, [string, string, number]>(`
      SELECT 1 AS found FROM candles WHERE datasetId = ? AND timeframe = ? AND time > ? LIMIT 1
    `)
        .get(datasetId, timeframe, last) !== null;
    return { hasMore, hasNewer, candles };
  }

  loadDrawings(instrumentId: string): string | undefined {
    this.instrument(instrumentId);
    return this.db
      .query<{ json: string }, [string]>(
        'SELECT json FROM drawings WHERE instrumentId = ?',
      )
      .get(instrumentId)?.json;
  }

  saveDrawings(instrumentId: string, json: string): void {
    this.instrument(instrumentId);
    this.db
      .query(`INSERT INTO drawings VALUES (?, ?)
      ON CONFLICT(instrumentId) DO UPDATE SET json=excluded.json`)
      .run(instrumentId, json);
  }

  private instrument(id: string): Instrument {
    const instrument = this.db
      .query<Instrument, [string]>(
        `SELECT ${INSTRUMENT_COLUMNS} FROM instruments WHERE id = ?`,
      )
      .get(id);
    if (!instrument)
      throw new MarketDataError('Инструмент больше не существует.', 404);
    return instrument;
  }

  private parseFile(
    source: SourceRecord,
    datasetId: string,
    onProgress: (progress: ImportProgress) => void,
    signal?: AbortSignal,
  ): Promise<ImportStats> {
    return new Promise((resolve, reject) => {
      const stream = createReadStream(source.sourcePath, {
        encoding: 'utf8',
        highWaterMark: READ_CHUNK_BYTES,
      });
      const aggregator = new CandleAggregator();
      const insert = this.db.query(
        'INSERT INTO candles VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      const insertBatch = this.db.transaction((candles: AggregatedCandle[]) => {
        for (const candle of candles) {
          insert.run(
            datasetId,
            candle.timeframe,
            candle.time,
            candle.open,
            candle.high,
            candle.low,
            candle.close,
          );
        }
      });
      let headerRead = false;
      let rowCount = 0;
      let firstTime: number | undefined;
      let previousTime: number | undefined;
      let precision = 0;
      let parser: Papa.Parser | undefined;
      let settled = false;
      const cleanUp = (): void => {
        signal?.removeEventListener('abort', cancel);
        stream.destroy();
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        parser?.abort();
        cleanUp();
        reject(error);
      };
      const cancel = (): void =>
        fail(new DOMException('Импорт отменён.', 'AbortError'));
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) {
        cancel();
        return;
      }
      Papa.parse<string[]>(stream, {
        delimiter: ',',
        header: false,
        dynamicTyping: false,
        skipEmptyLines: true,
        beforeFirstChunk: (chunk) => chunk.replace(/^\uFEFF/, ''),
        chunk: (result, handle) => {
          parser = handle;
          if (settled) return;
          try {
            assertNotCancelled(signal);
            if (result.errors.length) {
              throw new MarketDataError(
                `Некорректный CSV: ${result.errors[0].message}`,
              );
            }
            const completed: AggregatedCandle[] = [];
            for (const row of result.data) {
              if (!headerRead) {
                validate(() => validateCsvHeader(row));
                headerRead = true;
                continue;
              }
              const candle = validate(() =>
                parseCsvCandle(row, rowCount + 2, previousTime),
              );
              if (precision < 8) {
                precision = Math.max(precision, candlePricePrecision(candle));
              }
              firstTime ??= candle.time;
              previousTime = candle.time;
              rowCount++;
              completed.push(...aggregator.add(candle));
            }
            insertBatch(completed);
            onProgress({
              percent: Math.min(
                99,
                Math.floor((stream.bytesRead / source.sourceSize) * 100),
              ),
              rows: rowCount,
              phase: 'reading',
            });
            assertNotCancelled(signal);
          } catch (error) {
            fail(error);
          }
        },
        complete: () => {
          if (settled) return;
          try {
            assertNotCancelled(signal);
            if (firstTime === undefined || previousTime === undefined) {
              throw new MarketDataError('CSV-файл не содержит свечей.');
            }
            insertBatch(aggregator.flush());
            settled = true;
            cleanUp();
            resolve({
              rowCount,
              firstTime,
              lastTime: previousTime,
              pricePrecision: precision,
            });
          } catch (error) {
            fail(error);
          }
        },
        error: () =>
          fail(
            new MarketDataError(
              'Не удалось прочитать выбранный CSV-файл.',
              409,
            ),
          ),
      });
    });
  }
}
