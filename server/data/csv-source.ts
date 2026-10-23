import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import Papa from 'papaparse';

const READ_CHUNK_BYTES = 1024 * 1024;

export interface CsvRecord {
  values: string[];
  /** UTF-16 offset within the decoded chunk, including any leading empty rows. */
  characterOffset: number;
}

export interface CsvSourceChunk {
  records: CsvRecord[];
  text: string;
  byteOffset: number;
  bytesRead: number;
}

export class CsvSourceError extends Error {}

/** Convert only the sparse checkpoints to bytes, rather than encoding every row. */
export function recordByteOffset(
  chunk: CsvSourceChunk,
  record: CsvRecord,
): number {
  return (
    chunk.byteOffset +
    Buffer.byteLength(chunk.text.slice(0, record.characterOffset), 'utf8')
  );
}

async function sourceNewline(filePath: string): Promise<'\n' | '\r' | '\r\n'> {
  const file = await open(filePath, 'r');
  try {
    // The validated six-column header is short and contains no embedded newline.
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return (
      (buffer
        .subarray(0, bytesRead)
        .toString('utf8')
        .match(/\r\n|\n|\r/)?.[0] as '\n' | '\r' | '\r\n' | undefined) ?? '\n'
    );
  } finally {
    await file.close();
  }
}

/**
 * Papa owns CSV record framing, including quoted newlines. The carried suffix is
 * the only text retained between disk chunks; offsets always refer to the source.
 */
export async function* readCsvSource(
  filePath: string,
  {
    byteOffset = 0,
    signal,
    chunkBytes = READ_CHUNK_BYTES,
  }: { byteOffset?: number; signal?: AbortSignal; chunkBytes?: number } = {},
): AsyncGenerator<CsvSourceChunk> {
  signal?.throwIfAborted();
  const newline = await sourceNewline(filePath);
  signal?.throwIfAborted();
  const stream = createReadStream(filePath, {
    encoding: 'utf8',
    start: byteOffset,
    highWaterMark: chunkBytes,
    signal,
  });
  let pending = '';
  let baseBytes = byteOffset;
  let firstChunk = byteOffset === 0;
  let records: CsvRecord[] = [];
  let previousCursor = 0;
  const parser = new Papa.Parser({
    delimiter: ',',
    newline,
    step: (value) => {
      // The low-level public Parser returns rows, unlike Papa.parse's handle.
      const result = value as unknown as Papa.ParseResult<string[]>;
      if (result.errors.length)
        throw new CsvSourceError(
          `Некорректный CSV: ${result.errors[0].message}`,
        );
      const row = result.data[0];
      if (row && !(row.length === 1 && row[0] === '')) {
        records.push({ values: row, characterOffset: previousCursor });
      }
      previousCursor = result.meta.cursor;
    },
  });

  function parse(finished: boolean): CsvSourceChunk {
    records = [];
    previousCursor = 0;
    // Papa must see a whole CRLF token after a closing quote.
    const input =
      !finished && newline === '\r\n' && pending.endsWith('\r')
        ? pending.slice(0, -1)
        : pending;
    const result = parser.parse(input, 0, !finished) as Papa.ParseResult<
      string[]
    >;
    if (result.errors.length)
      throw new CsvSourceError(`Некорректный CSV: ${result.errors[0].message}`);
    const chunk = {
      records,
      text: pending,
      byteOffset: baseBytes,
      bytesRead: byteOffset + stream.bytesRead,
    };
    const consumed = result.meta.cursor;
    baseBytes += Buffer.byteLength(pending.slice(0, consumed), 'utf8');
    pending = pending.slice(consumed);
    return chunk;
  }

  try {
    for await (const input of stream) {
      signal?.throwIfAborted();
      let text = String(input);
      if (firstChunk) {
        firstChunk = false;
        if (text.startsWith('\uFEFF')) {
          text = text.slice(1);
          baseBytes += 3;
        }
      }
      pending += text;
      const chunk = parse(false);
      if (chunk.records.length) yield chunk;
    }
    signal?.throwIfAborted();
    const chunk = parse(true);
    if (chunk.records.length) yield chunk;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw error;
  } finally {
    stream.destroy();
  }
}
