import type { ImportEvent } from '../src/application/service-contract';
import {
  type DiskImportInput,
  LocalMarketStore,
  MarketDataError,
} from './data/market-store';

type WorkerRequest =
  | { type: 'start'; input: DiskImportInput; dataDir: string }
  | { type: 'cancel' };
const abort = new AbortController();

self.addEventListener('message', async (event: MessageEvent<WorkerRequest>) => {
  if (event.data.type === 'cancel') {
    abort.abort();
    return;
  }
  let store: LocalMarketStore | undefined;
  let result: ImportEvent;
  try {
    store = new LocalMarketStore({
      dataDir: event.data.dataDir,
      recoverIncomplete: false,
    });
    const instrument = await store.importInstrument(
      event.data.input,
      (progress) => {
        self.postMessage({ type: 'progress', progress } satisfies ImportEvent);
      },
      abort.signal,
    );
    result = { type: 'complete', instrument };
  } catch (cause) {
    result = {
      type: 'error',
      name: cause instanceof Error ? cause.name : 'Error',
      message:
        cause instanceof MarketDataError ||
        (cause instanceof DOMException && cause.name === 'AbortError')
          ? cause.message
          : 'Не удалось обработать CSV. Проверьте свободное место на диске и повторите попытку.',
    };
  } finally {
    store?.close();
  }
  self.postMessage(result);
});
