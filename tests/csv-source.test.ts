import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import Papa from 'papaparse';
import { readCsvSource, recordByteOffset } from '../server/data/csv-source';

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (
      dirname(resolve(directory)) !== resolve(tmpdir()) ||
      !basename(directory).startsWith('terminal-csv-source-')
    )
      throw new Error('Unexpected cleanup target');
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(csv: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'terminal-csv-source-'));
  directories.push(directory);
  const filePath = join(directory, 'source.csv');
  await writeFile(filePath, csv);
  return filePath;
}

describe('source CSV byte offsets', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    test(`keeps exact UTF-8 record positions across tiny ${JSON.stringify(newline)} chunks`, async () => {
      const csv = `\uFEFFTime,Open,High,Low,Close,Volume${newline}${newline}"2026-01-01 00:00:00Z",1,3,1,2,"объём 🚀, ${newline}с кавычкой ""да"""${newline}2026-01-01 00:00:01Z,2,4,2,3,0`;
      const expected = Papa.parse<string[]>(csv, {
        skipEmptyLines: true,
        newline: newline as '\n' | '\r' | '\r\n',
      }).data;
      const filePath = await fixture(csv);
      for (const chunkBytes of [1, 7, 31, 1024]) {
        const rows: string[][] = [];
        const offsets: number[] = [];
        for await (const chunk of readCsvSource(filePath, { chunkBytes })) {
          for (const record of chunk.records) {
            rows.push(record.values);
            offsets.push(recordByteOffset(chunk, record));
          }
        }
        expect(rows).toEqual(expected);
        const bytes = Buffer.from(csv, 'utf8');
        expect(bytes.subarray(offsets[0]).toString('utf8')).toStartWith(
          'Time,',
        );
        expect(bytes.subarray(offsets[1]).toString('utf8')).toStartWith(
          '"2026-',
        );
        expect(bytes.subarray(offsets[2]).toString('utf8')).toStartWith(
          '2026-',
        );
        const resumed: string[][] = [];
        for await (const chunk of readCsvSource(filePath, {
          byteOffset: offsets[1],
          chunkBytes,
        }))
          resumed.push(...chunk.records.map((record) => record.values));
        expect(resumed).toEqual(expected.slice(1));
      }
    });
  }

  test('reports an unterminated quoted record instead of accepting a partial row', async () => {
    const filePath = await fixture('a,b\n1,"unfinished');
    const read = async () => {
      for await (const _chunk of readCsvSource(filePath, { chunkBytes: 3 })) {
        // Consume the stream through its final record.
      }
    };
    await expect(read()).rejects.toThrow('Некорректный CSV');
  });

  test('honors cancellation while a stream is being consumed', async () => {
    const filePath = await fixture('a,b\n1,2\n3,4\n');
    const controller = new AbortController();
    const read = async () => {
      for await (const _chunk of readCsvSource(filePath, {
        chunkBytes: 4,
        signal: controller.signal,
      }))
        controller.abort();
    };
    await expect(read()).rejects.toMatchObject({ name: 'AbortError' });
  });
});
