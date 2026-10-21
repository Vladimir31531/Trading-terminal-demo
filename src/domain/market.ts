export const TIMEFRAMES = [
  '1m',
  '5m',
  '15m',
  '30m',
  '1H',
  '4h',
  '1D',
  '1W',
  '1M',
] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface Instrument {
  id: string;
  ticker: string;
  datasetId: string;
  fileName: string;
  fileSize: number;
  rowCount: number;
  firstTime: number;
  lastTime: number;
  createdAt: number;
}

export interface ImportProgress {
  percent: number;
  rows: number;
  phase: 'reading' | 'saving';
}

export interface ImportInput {
  ticker: string;
  sourceId: string;
  instrumentId?: string;
}

export interface SourceFile {
  id: string;
  name: string;
  kind: 'file';
  size: number;
}

export interface SourceDirectory {
  id: string;
  name: string;
  kind: 'directory';
}

export interface DirectoryListing {
  id: string;
  path: string;
  parentId?: string;
  roots: SourceDirectory[];
  entries: (SourceFile | SourceDirectory)[];
}

export interface HistoryPage {
  candles: Candle[];
  hasMore: boolean;
  hasNewer: boolean;
}
