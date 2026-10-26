import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Server } from 'bun';
import type { ServiceIdentity } from '../src/application/service-contract';
import { TIMEFRAMES, type Timeframe } from '../src/domain/market';
import type { ServiceConfig } from './config';
import { LocalMarketStore, MarketDataError } from './data/market-store';
import { HttpError } from './http-error';
import { ImportCoordinator } from './import-coordinator';
import { isWithinDirectory, SourceCatalog } from './source-catalog';

export function requestIsLocal(request: Request, port: number): boolean {
  const url = new URL(request.url);
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const host = request.headers.get('host') ?? url.host;
  const origin = request.headers.get('origin');
  return (
    allowedHosts.has(host) &&
    (!origin ||
      origin === `http://127.0.0.1:${port}` ||
      origin === `http://localhost:${port}`)
  );
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

async function body(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new HttpError(400, 'Ожидается корректный JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, 'Ожидается JSON-объект.');
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new HttpError(400, `Укажите ${name}.`);
  return value;
}

function timestamp(value: string | null): number | undefined {
  if (value === null) return undefined;
  const result = Number(value);
  if (!value.trim() || !Number.isFinite(result))
    throw new HttpError(400, 'Некорректная граница времени.');
  return result;
}

export function createApplication(
  config: ServiceConfig,
  identity: ServiceIdentity,
  devOrigin?: string,
) {
  const store = new LocalMarketStore({ dataDir: config.dataDir });
  const sources = new SourceCatalog(config.dataDirectories);
  const imports = new ImportCoordinator(config.dataDir, store);
  const token = crypto.randomUUID();
  const distRoot = resolve(config.projectRoot, 'dist');

  async function servePage(request: Request): Promise<Response> {
    if (!['GET', 'HEAD'].includes(request.method))
      throw new HttpError(405, 'Метод не поддерживается.');
    const url = new URL(request.url);
    if (devOrigin) {
      const target = new URL(devOrigin);
      target.pathname = url.pathname;
      target.search = url.search;
      const headers = new Headers(request.headers);
      headers.delete('host');
      try {
        return await fetch(target, {
          headers,
          method: request.method,
          signal: request.signal,
          decompress: false,
        });
      } catch {
        return new Response(
          'Интерфейс запускается. Обновите страницу через несколько секунд.',
          { status: 503 },
        );
      }
    }
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, 'Некорректный адрес.');
    }
    if (path !== '/' && !path.startsWith('/static/'))
      throw new HttpError(404, 'Страница не найдена.');
    const candidate =
      path === '/'
        ? resolve(distRoot, 'index.html')
        : resolve(distRoot, `.${path}`);
    let actual: string;
    try {
      actual = await realpath(candidate);
    } catch {
      throw new HttpError(
        404,
        'Файл интерфейса не найден. Выполните bun run build.',
      );
    }
    if (!isWithinDirectory(distRoot, actual))
      throw new HttpError(404, 'Файл не найден.');
    return new Response(request.method === 'HEAD' ? null : Bun.file(actual), {
      headers: {
        'Cache-Control':
          path === '/' ? 'no-cache' : 'public, max-age=31536000, immutable',
        'Content-Type': Bun.file(actual).type,
      },
    });
  }

  return {
    async fetch(
      request: Request,
      server?: Pick<Server<undefined>, 'timeout'>,
    ): Promise<Response> {
      const requestId = crypto.randomUUID();
      try {
        if (!requestIsLocal(request, config.port))
          throw new HttpError(
            403,
            'Доступ разрешён только локальному приложению.',
          );
        const url = new URL(request.url);
        const path = url.pathname;
        if (!path.startsWith('/api/')) return await servePage(request);
        if (request.method === 'GET' && path === '/api/health')
          return json(identity);
        if (request.method === 'GET' && path === '/api/session')
          return json({ token });
        if (request.headers.get('X-Terminal-Token') !== token)
          throw new HttpError(401, 'Сервис перезапущен. Повторите действие.');
        if (request.method === 'GET' && path === '/api/files')
          return json(
            await sources.list(
              url.searchParams.get('directoryId') ?? undefined,
            ),
          );
        if (request.method === 'GET' && path === '/api/instruments')
          return json(store.listInstruments());
        if (request.method === 'POST' && path === '/api/imports') {
          const input = await body(request);
          const sourceId = text(input.sourceId, 'CSV-файл');
          const ticker = text(input.ticker, 'тикер');
          const instrumentId =
            input.instrumentId === undefined
              ? undefined
              : text(input.instrumentId, 'инструмент');
          const pointSize =
            input.pointSize === undefined ? undefined : Number(input.pointSize);
          if (
            pointSize !== undefined &&
            (!Number.isFinite(pointSize) || pointSize <= 0)
          )
            throw new HttpError(400, 'Размер пункта должен быть больше нуля.');
          const filePath = await sources.filePath(sourceId);
          server?.timeout(request, 0);
          return new Response(
            imports.stream(
              { filePath, ticker, instrumentId, pointSize },
              request.signal,
            ),
            {
              headers: {
                'Content-Type': 'application/x-ndjson; charset=utf-8',
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
              },
            },
          );
        }
        const instrument = /^\/api\/instruments\/([^/]+)$/.exec(path);
        if (request.method === 'DELETE' && instrument) {
          store.deleteInstrument(instrument[1]);
          return new Response(null, {
            status: 204,
            headers: { 'Cache-Control': 'no-store' },
          });
        }
        if (request.method === 'PATCH' && instrument) {
          const input = await body(request);
          const ticker = text(input.ticker, 'тикер');
          if (input.pointSize === undefined) {
            store.renameInstrument(instrument[1], ticker);
            return json({ ok: true });
          }
          const pointSize = Number(input.pointSize);
          if (!Number.isFinite(pointSize) || pointSize <= 0)
            throw new HttpError(400, 'Размер пункта должен быть больше нуля.');
          return json(store.updateInstrument(instrument[1], ticker, pointSize));
        }
        if (request.method === 'GET' && path === '/api/candles') {
          const datasetId = text(
            url.searchParams.get('datasetId'),
            'набор данных',
          );
          const timeframe = text(
            url.searchParams.get('timeframe'),
            'таймфрейм',
          );
          if (!TIMEFRAMES.includes(timeframe as Timeframe))
            throw new HttpError(400, 'Неизвестный таймфрейм.');
          const before = timestamp(url.searchParams.get('before'));
          const after = timestamp(url.searchParams.get('after'));
          const asOf = timestamp(url.searchParams.get('asOf'));
          if (before !== undefined && after !== undefined)
            throw new HttpError(
              400,
              'Используйте только одну границу времени.',
            );
          const limit = Number(url.searchParams.get('limit') ?? 800);
          if (!Number.isInteger(limit) || limit < 1 || limit > 2000)
            throw new HttpError(
              400,
              'Размер порции должен быть от 1 до 2000 свечей.',
            );
          if (asOf !== undefined) server?.timeout(request, 0);
          return json(
            await store.loadCandles(
              datasetId,
              timeframe as Timeframe,
              before,
              limit,
              after,
              asOf,
              request.signal,
            ),
          );
        }
        if (request.method === 'GET' && path === '/api/seconds') {
          const datasetId = text(
            url.searchParams.get('datasetId'),
            'набор данных',
          );
          const from = timestamp(url.searchParams.get('from'));
          const through = timestamp(url.searchParams.get('through'));
          const after = timestamp(url.searchParams.get('after'));
          if (from === undefined || through === undefined)
            throw new HttpError(400, 'Укажите диапазон симуляции.');
          const limit = Number(url.searchParams.get('limit') ?? 2000);
          if (!Number.isInteger(limit) || limit < 1 || limit > 5000)
            throw new HttpError(
              400,
              'Размер порции должен быть от 1 до 5000 свечей.',
            );
          server?.timeout(request, 0);
          return json(
            await store.loadSeconds(
              datasetId,
              from,
              through,
              after,
              limit,
              request.signal,
            ),
          );
        }
        const drawings = /^\/api\/drawings\/([^/]+)$/.exec(path);
        if (request.method === 'GET' && drawings)
          return json({ json: store.loadDrawings(drawings[1]) });
        if (request.method === 'PUT' && drawings) {
          const saved = text((await body(request)).json, 'рисунки');
          try {
            if (!Array.isArray(JSON.parse(saved))) throw new Error();
          } catch {
            throw new HttpError(400, 'Некорректные данные рисунков.');
          }
          store.saveDrawings(drawings[1], saved);
          return json({ ok: true });
        }
        throw new HttpError(404, 'Запрос не найден.');
      } catch (cause) {
        if (cause instanceof HttpError || cause instanceof MarketDataError)
          return json({ message: cause.message }, cause.status);
        console.error(
          JSON.stringify({
            level: 'error',
            requestId,
            event: 'request_failed',
            error: cause instanceof Error ? cause.name : 'UnknownError',
          }),
        );
        return json(
          {
            message: 'Не удалось выполнить запрос локального сервиса.',
            requestId,
          },
          500,
        );
      }
    },
    async close() {
      await imports.close();
      store.close();
    },
  };
}
