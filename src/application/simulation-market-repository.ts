import type { MarketRepository } from './market-repository';
import type { SimulationEngine } from './simulation-engine';

/** Keep annotations for one simulation without writing them to the instrument. */
export function withSimulationDrawings(
  repository: MarketRepository,
  simulation: Pick<SimulationEngine, 'getSnapshot'>,
  initialDrawings?: string,
): MarketRepository {
  let drawings = initialDrawings;
  const finished = () => {
    const { status } = simulation.getSnapshot();
    return status === 'finished' || status === 'error';
  };
  return {
    ...repository,
    async loadDrawings() {
      if (finished()) drawings = undefined;
      return drawings;
    },
    async saveDrawings(_instrumentId, json) {
      drawings = finished() ? undefined : json;
    },
  };
}
