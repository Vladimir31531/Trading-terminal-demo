import type {
  DirectoryListing,
  HistoryPage,
  ImportInput,
  ImportProgress,
  Instrument,
  Timeframe,
} from '../domain/market';

export interface MarketRepository {
  listSources(
    directoryId?: string,
    signal?: AbortSignal,
  ): Promise<DirectoryListing>;
  listInstruments(): Promise<Instrument[]>;
  importInstrument(
    input: ImportInput,
    onProgress: (progress: ImportProgress) => void,
    signal?: AbortSignal,
  ): Promise<Instrument>;
  renameInstrument(id: string, ticker: string): Promise<void>;
  deleteInstrument(id: string): Promise<void>;
  loadCandles(
    datasetId: string,
    timeframe: Timeframe,
    before?: number,
    limit?: number,
    after?: number,
    asOf?: number,
    signal?: AbortSignal,
  ): Promise<HistoryPage>;
  loadSeconds(
    datasetId: string,
    from: number,
    through: number,
    after?: number,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<HistoryPage>;
  loadDrawings(instrumentId: string): Promise<string | undefined>;
  saveDrawings(instrumentId: string, json: string): Promise<void>;
}
