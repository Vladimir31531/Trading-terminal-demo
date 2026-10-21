import type { ImportEvent } from '../src/application/service-contract';
import type { DiskImportInput, LocalMarketStore } from './data/market-store';
import { HttpError } from './http-error';

interface ActiveImport {
  cancel(): void;
  done: Promise<void>;
}

export class ImportCoordinator {
  private active?: ActiveImport;

  constructor(
    private readonly dataDir: string,
    private readonly store: LocalMarketStore,
  ) {}

  stream(
    input: DiskImportInput,
    signal: AbortSignal,
  ): ReadableStream<Uint8Array> {
    if (this.active)
      throw new HttpError(409, 'Дождитесь завершения текущего импорта.');
    const worker = new Worker(
      new URL('./import.worker.ts', import.meta.url).href,
    );
    let finished = false;
    let streamClosed = false;
    let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
    let settle: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const send = (event: ImportEvent) => {
      if (!streamClosed)
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
    };
    const finish = (recover: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(cancellationTimer);
      signal.removeEventListener('abort', cancel);
      worker.terminate();
      try {
        if (recover) this.store.recoverIncompleteImports();
      } catch {
        console.error(
          JSON.stringify({ level: 'error', event: 'import_recovery_failed' }),
        );
      } finally {
        if (!streamClosed) {
          streamClosed = true;
          controller.close();
        }
        this.active = undefined;
        settle();
      }
    };
    const cancel = () => {
      if (finished || cancellationTimer) return;
      worker.postMessage({ type: 'cancel' });
      cancellationTimer = setTimeout(() => finish(true), 5000);
    };
    const stream = new ReadableStream<Uint8Array>({
      start: (output) => {
        controller = output;
      },
      cancel: () => {
        streamClosed = true;
        cancel();
      },
    });
    this.active = { done, cancel };
    worker.onmessage = (event: MessageEvent<ImportEvent>) => {
      send(event.data);
      if (event.data.type !== 'progress') finish(false);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      send({
        type: 'error',
        name: 'Error',
        message: 'Фоновый импорт прерван. Повторите подключение CSV.',
      });
      finish(true);
    };
    signal.addEventListener('abort', cancel, { once: true });
    worker.postMessage({ type: 'start', input, dataDir: this.dataDir });
    if (signal.aborted) cancel();
    return stream;
  }

  async close(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.cancel();
    await active.done;
  }
}
