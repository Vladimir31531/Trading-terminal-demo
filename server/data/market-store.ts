import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import {
  type AggregatedCandle,
  CandleAggregator,
  candleStart,
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
import { CsvSourceError, readCsvSource, recordByteOffset } from './csv-source';

const MAX_PAGE_SIZE = 5000;
const SOURCE_INDEX_INTERVAL = 4096;
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

interface ActiveSource extends SourceRecord {
  firstTime: number;
  lastTime: number;
}

interface SourceOffset {
  time: number;
  byteOffset: number;
  rowNumber: number;
}

interface IndexBuild {
  controller: AbortController;
  promise: Promise<void>;
  users: number;
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
  private readonly indexBuilds = new Map<string, IndexBuild>();
  private closed = false;

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
      CREATE TABLE IF NOT EXISTS source_offsets (
        datasetId TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
        time REAL NOT NULL,
        byteOffset INTEGER NOT NULL,
        rowNumber INTEGER NOT NULL,
        PRIMARY KEY (datasetId, time)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS source_indexes (
        datasetId TEXT PRIMARY KEY REFERENCES datasets(id) ON DELETE CASCADE
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
    this.closed = true;
    for (const build of this.indexBuilds.values()) build.controller.abort();
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
        this.cancelIndex(instrument.datasetId);
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
        if (existing) this.cancelIndex(existing.datasetId);
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
    asOf?: number,
    signal?: AbortSignal,
  ): Promise<HistoryPage> {
    signal?.throwIfAborted();
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
      (asOf !== undefined && !Number.isFinite(asOf)) ||
      (before !== undefined && after !== undefined)
    )
      throw new MarketDataError('Некорректная граница истории.');
    const source = this.source(datasetId);
    await assertSourceUnchanged(source);
    signal?.throwIfAborted();
    if (asOf !== undefined)
      return this.loadSnapshot(
        datasetId,
        timeframe,
        asOf,
        source,
        before,
        limit,
        after,
        signal,
      );
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

  async loadSeconds(
    datasetId: string,
    from: number,
    through: number,
    after?: number,
    limit = 2000,
    signal?: AbortSignal,
  ): Promise<HistoryPage> {
    signal?.throwIfAborted();
    if (
      !Number.isFinite(from) ||
      !Number.isFinite(through) ||
      from > through ||
      (after !== undefined && !Number.isFinite(after))
    )
      throw new MarketDataError('Некорректный диапазон симуляции.');
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE)
      throw new MarketDataError(
        `Размер порции должен быть от 1 до ${MAX_PAGE_SIZE}.`,
      );
    const source = this.source(datasetId);
    await assertSourceUnchanged(source);
    signal?.throwIfAborted();
    if (
      through < source.firstTime ||
      from > source.lastTime ||
      (after !== undefined && after >= Math.min(through, source.lastTime))
    )
      return { candles: [], hasMore: false, hasNewer: false };
    await this.ensureSourceIndex(datasetId, source, signal);
    signal?.throwIfAborted();
    this.source(datasetId);
    const seekTime = Math.max(from, after ?? from);
    const offset =
      this.db
        .query<SourceOffset, [string, number]>(`
        SELECT time, byteOffset, rowNumber FROM source_offsets
        WHERE datasetId = ? AND time <= ? ORDER BY time DESC LIMIT 1
      `)
        .get(datasetId, seekTime) ??
      this.db
        .query<SourceOffset, [string]>(`
        SELECT time, byteOffset, rowNumber FROM source_offsets
        WHERE datasetId = ? ORDER BY time LIMIT 1
      `)
        .get(datasetId);
    if (!offset)
      throw new MarketDataError('Не удалось прочитать индекс CSV.', 409);
    const candles: Candle[] = [];
    let rowNumber = offset.rowNumber;
    let previousTime: number | undefined;
    try {
      reading: for await (const chunk of readCsvSource(source.sourcePath, {
        byteOffset: offset.byteOffset,
        signal,
      })) {
        for (const record of chunk.records) {
          const candle = validate(() =>
            parseCsvCandle(record.values, rowNumber++, previousTime),
          );
          previousTime = candle.time;
          if (candle.time > through) break reading;
          if (
            candle.time < from ||
            (after !== undefined && candle.time <= after)
          )
            continue;
          candles.push(candle);
          if (candles.length > limit) break reading;
        }
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof MarketDataError) throw error;
      throw new MarketDataError(
        error instanceof CsvSourceError
          ? error.message
          : 'Не удалось прочитать исходный CSV.',
        409,
      );
    }
    signal?.throwIfAborted();
    this.source(datasetId);
    await assertSourceUnchanged(source);
    const hasMore = candles.length > limit;
    if (hasMore) candles.pop();
    return { candles, hasMore, hasNewer: false };
  }

  private source(datasetId: string): ActiveSource {
    const source = this.db
      .query<ActiveSource, [string]>(`
      SELECT sourcePath, sourceSize, sourceModifiedAt, firstTime, lastTime
      FROM datasets JOIN instruments ON instruments.datasetId = datasets.id
      WHERE datasets.id = ?
    `)
      .get(datasetId);
    if (!source)
      throw new MarketDataError(
        'Данные инструмента больше не существуют.',
        404,
      );
    return source;
  }

  private cancelIndex(datasetId: string): void {
    this.indexBuilds
      .get(datasetId)
      ?.controller.abort(
        new MarketDataError('Данные инструмента больше не существуют.', 404),
      );
  }

  private async ensureSourceIndex(
    datasetId: string,
    source: SourceRecord,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    if (
      this.db
        .query('SELECT 1 FROM source_indexes WHERE datasetId = ?')
        .get(datasetId)
    )
      return;
    let build = this.indexBuilds.get(datasetId);
    if (build?.controller.signal.aborted) {
      // Finish the cancelled writer's cleanup before a retry starts its own index.
      await build.promise.catch(() => undefined);
      signal?.throwIfAborted();
      return this.ensureSourceIndex(datasetId, source, signal);
    }
    if (!build) {
      const controller = new AbortController();
      const promise = this.buildSourceIndex(
        datasetId,
        source,
        controller.signal,
      );
      build = { controller, promise, users: 0 };
      this.indexBuilds.set(datasetId, build);
      const clear = (): void => {
        if (this.indexBuilds.get(datasetId)?.promise === promise)
          this.indexBuilds.delete(datasetId);
      };
      void promise.then(clear, clear);
    }
    build.users++;
    let cancel: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      if (!signal) return;
      cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    });
    try {
      await Promise.race([build.promise, cancelled]);
    } finally {
      if (cancel) signal?.removeEventListener('abort', cancel);
      build.users--;
      if (build.users === 0) build.controller.abort();
    }
  }

  private async buildSourceIndex(
    datasetId: string,
    source: SourceRecord,
    signal: AbortSignal,
  ): Promise<void> {
    const insert = this.db.query(
      'INSERT INTO source_offsets VALUES (?, ?, ?, ?)',
    );
    const insertBatch = this.db.transaction((offsets: SourceOffset[]) => {
      for (const offset of offsets)
        insert.run(datasetId, offset.time, offset.byteOffset, offset.rowNumber);
    });
    let headerRead = false;
    let rowCount = 0;
    let previousTime: number | undefined;
    try {
      this.db
        .query('DELETE FROM source_offsets WHERE datasetId = ?')
        .run(datasetId);
      for await (const chunk of readCsvSource(source.sourcePath, { signal })) {
        signal.throwIfAborted();
        const offsets: SourceOffset[] = [];
        for (const record of chunk.records) {
          if (!headerRead) {
            validate(() => validateCsvHeader(record.values));
            headerRead = true;
            continue;
          }
          const candle = validate(() =>
            parseCsvCandle(record.values, rowCount + 2, previousTime),
          );
          if (rowCount % SOURCE_INDEX_INTERVAL === 0)
            offsets.push({
              time: candle.time,
              byteOffset: recordByteOffset(chunk, record),
              rowNumber: rowCount + 2,
            });
          rowCount++;
          previousTime = candle.time;
        }
        insertBatch(offsets);
      }
      signal.throwIfAborted();
      await assertSourceUnchanged(source);
      signal.throwIfAborted();
      this.source(datasetId);
      this.db.query('INSERT INTO source_indexes VALUES (?)').run(datasetId);
    } catch (error) {
      if (!this.closed)
        this.db
          .query('DELETE FROM source_offsets WHERE datasetId = ?')
          .run(datasetId);
      if (signal.aborted) throw signal.reason;
      if (error instanceof MarketDataError) throw error;
      throw new MarketDataError(
        error instanceof CsvSourceError
          ? error.message
          : 'Не удалось подготовить индекс исходного CSV.',
        409,
      );
    }
  }

  private async partialCandle(
    datasetId: string,
    timeframe: Timeframe,
    asOf: number,
    signal?: AbortSignal,
  ): Promise<Candle | undefined> {
    const start = candleStart(asOf, timeframe);
    const minute = candleStart(asOf, '1m');
    const prefix = this.db
      .query<
        {
          firstTime: number | null;
          lastTime: number | null;
          high: number | null;
          low: number | null;
        },
        [string, number, number]
      >(`
      SELECT MIN(time) AS firstTime, MAX(time) AS lastTime,
        MAX(high) AS high, MIN(low) AS low
      FROM candles WHERE datasetId = ? AND timeframe = '1m' AND time >= ? AND time < ?
    `)
      .get(datasetId, start, minute);
    let partial: Candle | undefined;
    if (
      prefix &&
      prefix.firstTime !== null &&
      prefix.lastTime !== null &&
      prefix.high !== null &&
      prefix.low !== null
    ) {
      const price = this.db.query<
        Pick<Candle, 'open' | 'close'>,
        [string, number]
      >(
        "SELECT open, close FROM candles WHERE datasetId = ? AND timeframe = '1m' AND time = ?",
      );
      const first = price.get(datasetId, prefix.firstTime);
      const last = price.get(datasetId, prefix.lastTime);
      if (first && last)
        partial = {
          time: start,
          open: first.open,
          high: prefix.high,
          low: prefix.low,
          close: last.close,
        };
    }
    let after: number | undefined;
    let more = true;
    while (more) {
      const page = await this.loadSeconds(
        datasetId,
        minute,
        asOf,
        after,
        MAX_PAGE_SIZE,
        signal,
      );
      for (const candle of page.candles) {
        if (partial) {
          partial.high = Math.max(partial.high, candle.high);
          partial.low = Math.min(partial.low, candle.low);
          partial.close = candle.close;
        } else {
          partial = { ...candle, time: start };
        }
      }
      more = page.hasMore;
      after = page.candles.at(-1)?.time;
    }
    return partial;
  }

  private async loadSnapshot(
    datasetId: string,
    timeframe: Timeframe,
    asOf: number,
    source: SourceRecord,
    before: number | undefined,
    limit: number,
    after: number | undefined,
    signal?: AbortSignal,
  ): Promise<HistoryPage> {
    const boundary = candleStart(asOf, timeframe);
    const partial = await this.partialCandle(
      datasetId,
      timeframe,
      asOf,
      signal,
    );
    signal?.throwIfAborted();
    this.source(datasetId);
    const rows =
      after !== undefined
        ? this.db
            .query<Candle, [string, string, number, number, number]>(`
          SELECT time, open, high, low, close FROM candles
          WHERE datasetId = ? AND timeframe = ? AND time < ? AND time > ?
          ORDER BY time LIMIT ?
        `)
            .all(datasetId, timeframe, boundary, after, limit)
        : this.db
            .query<Candle, [string, string, number, number, number]>(`
          SELECT time, open, high, low, close FROM candles
          WHERE datasetId = ? AND timeframe = ? AND time < ? AND time < ?
          ORDER BY time DESC LIMIT ?
        `)
            .all(datasetId, timeframe, boundary, before ?? boundary, limit)
            .reverse();
    if (
      partial &&
      (before === undefined || partial.time < before) &&
      (after === undefined || partial.time > after)
    )
      rows.push(partial);
    const candles =
      after === undefined ? rows.slice(-limit) : rows.slice(0, limit);
    const first = candles[0]?.time ?? after ?? before;
    const last = candles.at(-1)?.time ?? before ?? after;
    const older = this.db.query<
      { found: number },
      [string, string, number, number]
    >(`
      SELECT 1 AS found FROM candles
      WHERE datasetId = ? AND timeframe = ? AND time < ? AND time < ? LIMIT 1
    `);
    const newer = this.db.query<
      { found: number },
      [string, string, number, number]
    >(`
      SELECT 1 AS found FROM candles
      WHERE datasetId = ? AND timeframe = ? AND time < ? AND time > ? LIMIT 1
    `);
    const hasMore =
      first !== undefined &&
      (older.get(datasetId, timeframe, boundary, first) !== null ||
        (partial !== undefined && partial.time < first));
    const hasNewer =
      last !== undefined &&
      (newer.get(datasetId, timeframe, boundary, last) !== null ||
        (partial !== undefined && partial.time > last));
    await assertSourceUnchanged(source);
    signal?.throwIfAborted();
    return { candles, hasMore, hasNewer };
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

  private async parseFile(
    source: SourceRecord,
    datasetId: string,
    onProgress: (progress: ImportProgress) => void,
    signal?: AbortSignal,
  ): Promise<ImportStats> {
    const aggregator = new CandleAggregator();
    const insert = this.db.query(
      'INSERT INTO candles VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const insertOffset = this.db.query(
      'INSERT INTO source_offsets VALUES (?, ?, ?, ?)',
    );
    const insertBatch = this.db.transaction(
      (candles: AggregatedCandle[], offsets: SourceOffset[]) => {
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
        for (const offset of offsets)
          insertOffset.run(
            datasetId,
            offset.time,
            offset.byteOffset,
            offset.rowNumber,
          );
      },
    );
    let headerRead = false;
    let rowCount = 0;
    let firstTime: number | undefined;
    let previousTime: number | undefined;
    let precision = 0;
    try {
      for await (const chunk of readCsvSource(source.sourcePath, { signal })) {
        assertNotCancelled(signal);
        const completed: AggregatedCandle[] = [];
        const offsets: SourceOffset[] = [];
        for (const record of chunk.records) {
          if (!headerRead) {
            validate(() => validateCsvHeader(record.values));
            headerRead = true;
            continue;
          }
          const candle = validate(() =>
            parseCsvCandle(record.values, rowCount + 2, previousTime),
          );
          if (precision < 8)
            precision = Math.max(precision, candlePricePrecision(candle));
          if (rowCount % SOURCE_INDEX_INTERVAL === 0)
            offsets.push({
              time: candle.time,
              byteOffset: recordByteOffset(chunk, record),
              rowNumber: rowCount + 2,
            });
          firstTime ??= candle.time;
          previousTime = candle.time;
          rowCount++;
          completed.push(...aggregator.add(candle));
        }
        insertBatch(completed, offsets);
        onProgress({
          percent: Math.min(
            99,
            Math.floor((chunk.bytesRead / source.sourceSize) * 100),
          ),
          rows: rowCount,
          phase: 'reading',
        });
        assertNotCancelled(signal);
      }
      assertNotCancelled(signal);
      if (firstTime === undefined || previousTime === undefined)
        throw new MarketDataError('CSV-файл не содержит свечей.');
      insertBatch(aggregator.flush(), []);
      this.db.query('INSERT INTO source_indexes VALUES (?)').run(datasetId);
      return {
        rowCount,
        firstTime,
        lastTime: previousTime,
        pricePrecision: precision,
      };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof MarketDataError) throw error;
      throw new MarketDataError(
        error instanceof CsvSourceError
          ? error.message
          : 'Не удалось прочитать выбранный CSV-файл.',
        error instanceof CsvSourceError ? 400 : 409,
      );
    }
  }
}
