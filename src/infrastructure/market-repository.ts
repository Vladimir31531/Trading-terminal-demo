import type { MarketRepository } from '../application/market-repository';
import type { ImportEvent } from '../application/service-contract';
import { normalizeTicker } from '../domain/csv-validation';
import type {
  DirectoryListing,
  HistoryPage,
  ImportInput,
  ImportProgress,
  Instrument,
} from '../domain/market';

const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_PAGE_SIZE = 800;
const MAX_EVENT_LENGTH = 65_536;
const drawingWrites = new Map<string, Promise<void>>();
let sessionToken: Promise<string> | undefined;

async function responseError(response: Response): Promise<Error> {
  const error = (await response.json().catch(() => undefined)) as
    | { message?: unknown }
    | undefined;
  return new Error(
    typeof error?.message === 'string'
      ? error.message
      : `Локальный сервис вернул ошибку ${response.status}.`,
  );
}

function getSessionToken(): Promise<string> {
  if (!sessionToken) {
    sessionToken = fetch('/api/session', {
      credentials: 'same-origin',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
      .then(async (response) => {
        if (!response.ok) throw await responseError(response);
        const result = (await response.json()) as { token: string };
        return result.token;
      })
      .catch((error: unknown) => {
        sessionToken = undefined;
        throw error;
      });
  }
  return sessionToken;
}

async function request(
  path: string,
  options: RequestInit = {},
  timeout = true,
): Promise<Response> {
  const signals = [
    options.signal,
    timeout ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : null,
  ].filter(
    (signal): signal is AbortSignal => signal !== null && signal !== undefined,
  );
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  try {
    signal?.throwIfAborted();
    const token = await getSessionToken();
    signal?.throwIfAborted();
    const response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      signal,
      headers: {
        ...options.headers,
        'X-Terminal-Token': token,
      },
    });
    if (!response.ok) {
      if (response.status === 401) sessionToken = undefined;
      throw await responseError(response);
    }
    return response;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof TypeError) {
      throw new Error(
        'Нет связи с локальным сервисом. Запустите проект командой bun run dev.',
      );
    }
    throw error;
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  return (await request(path, { signal })).json() as Promise<T>;
}

function jsonOptions(
  method: string,
  value: unknown,
  signal?: AbortSignal,
): RequestInit {
  return {
    method,
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  };
}

async function importInstrument(
  input: ImportInput,
  onProgress: (progress: ImportProgress) => void,
  signal?: AbortSignal,
): Promise<Instrument> {
  const response = await request(
    '/api/imports',
    jsonOptions(
      'POST',
      { ...input, ticker: normalizeTicker(input.ticker) },
      signal,
    ),
    false,
  );
  if (!response.body) throw new Error('Сервис не передал результат импорта.');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';

  function handleLine(line: string): Instrument | undefined {
    if (line.length > MAX_EVENT_LENGTH)
      throw new Error('Некорректный ответ сервиса импорта.');
    const event = JSON.parse(line) as ImportEvent;
    switch (event.type) {
      case 'progress':
        onProgress(event.progress);
        return undefined;
      case 'complete':
        return event.instrument;
      case 'error': {
        const error = new Error(event.message);
        error.name = event.name;
        throw error;
      }
      default:
        throw new Error('Некорректный ответ сервиса импорта.');
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += value ?? '';
      let end = pending.indexOf('\n');
      while (end !== -1) {
        const line = pending.slice(0, end).trim();
        pending = pending.slice(end + 1);
        if (line) {
          const instrument = handleLine(line);
          if (instrument) return instrument;
        }
        end = pending.indexOf('\n');
      }
      if (pending.length > MAX_EVENT_LENGTH)
        throw new Error('Некорректный ответ сервиса импорта.');
      if (done) {
        if (pending.trim()) {
          const instrument = handleLine(pending.trim());
          if (instrument) return instrument;
        }
        throw new Error('Связь с сервисом прервана до завершения импорта.');
      }
    }
  } finally {
    // An already aborted stream can reject cancellation; its original error is preserved.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function saveDrawings(instrumentId: string, json: string): Promise<void> {
  const previous = drawingWrites.get(instrumentId);
  // A failed earlier save must not prevent a subsequent edit from being saved.
  const write = (
    previous ? previous.catch(() => undefined) : Promise.resolve()
  ).then(async () => {
    await request(
      `/api/drawings/${encodeURIComponent(instrumentId)}`,
      jsonOptions('PUT', { json }),
    );
  });
  drawingWrites.set(instrumentId, write);
  const clear = (): void => {
    if (drawingWrites.get(instrumentId) === write)
      drawingWrites.delete(instrumentId);
  };
  void write.then(clear, clear);
  return write;
}

export const marketRepository: MarketRepository = {
  listSources(directoryId, signal) {
    const query = new URLSearchParams();
    if (directoryId) query.set('directoryId', directoryId);
    return getJson<DirectoryListing>(`/api/files?${query}`, signal);
  },

  listInstruments: () => getJson<Instrument[]>('/api/instruments'),

  importInstrument,

  async renameInstrument(id, ticker) {
    await request(
      `/api/instruments/${encodeURIComponent(id)}`,
      jsonOptions('PATCH', { ticker: normalizeTicker(ticker) }),
    );
  },

  async deleteInstrument(id) {
    await request(`/api/instruments/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  async loadCandles(
    datasetId,
    timeframe,
    before,
    limit = DEFAULT_PAGE_SIZE,
    after,
    asOf,
    signal,
  ) {
    if (!Number.isInteger(limit) || limit < 1)
      return Promise.reject(
        new Error('Размер страницы должен быть положительным.'),
      );
    const query = new URLSearchParams({
      datasetId,
      timeframe,
      limit: String(limit),
    });
    if (before !== undefined) query.set('before', String(before));
    if (after !== undefined) query.set('after', String(after));
    if (asOf !== undefined) query.set('asOf', String(asOf));
    return (
      await request(`/api/candles?${query}`, { signal }, asOf === undefined)
    ).json() as Promise<HistoryPage>;
  },

  async loadSeconds(datasetId, from, through, after, limit = 2000, signal) {
    const query = new URLSearchParams({
      datasetId,
      from: String(from),
      through: String(through),
      limit: String(limit),
    });
    if (after !== undefined) query.set('after', String(after));
    return (
      await request(`/api/seconds?${query}`, { signal }, false)
    ).json() as Promise<HistoryPage>;
  },

  async loadDrawings(instrumentId) {
    await drawingWrites.get(instrumentId);
    return (
      await getJson<{ json?: string }>(
        `/api/drawings/${encodeURIComponent(instrumentId)}`,
      )
    ).json;
  },

  saveDrawings,
};
