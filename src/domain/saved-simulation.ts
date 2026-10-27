import type { Instrument, Timeframe } from './market';
import type { SimulationCheckpoint, SimulationSettings } from './simulation';
import type { TradingCheckpoint } from './trading';

/** State needed to continue the same trading session after reopening the app. */
export interface SavedSimulation {
  sessionId: string;
  instrument: Instrument;
  settings: SimulationSettings;
  replay: SimulationCheckpoint;
  trading: TradingCheckpoint;
  timeframe: Timeframe;
  tradeVolume: string;
  drawings?: string;
  savedAt: number;
}
