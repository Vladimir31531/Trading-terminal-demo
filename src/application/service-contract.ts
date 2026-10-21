import type { ImportProgress, Instrument } from '../domain/market';

export type ImportEvent =
  | { type: 'progress'; progress: ImportProgress }
  | { type: 'complete'; instrument: Instrument }
  | { type: 'error'; message: string; name: string };

export interface ServiceIdentity {
  app: 'terminal-demo';
  projectId: string;
  protocolVersion: 1;
  mode: 'dev' | 'start';
  ready: boolean;
}
