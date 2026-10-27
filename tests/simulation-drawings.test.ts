import { describe, expect, mock, test } from 'bun:test';
import type { MarketRepository } from '../src/application/market-repository';
import { withSimulationDrawings } from '../src/application/simulation-market-repository';
import type { SimulationSnapshot } from '../src/domain/simulation';

const historicalDrawings = '[{"id":"historical-line"}]';
const sessionDrawings = '[{"id":"simulation-rectangle"}]';

function setup() {
  let snapshot: SimulationSnapshot = { status: 'playing', time: 100, speed: 1 };
  const loadDrawings = mock(async () => historicalDrawings);
  const saveDrawings = mock(async (_instrumentId: string, _json: string) => {});
  const loadCandles = mock(async () => ({
    candles: [],
    hasMore: false,
    hasNewer: false,
  }));
  const repository = {
    loadDrawings,
    saveDrawings,
    loadCandles,
  } as unknown as MarketRepository;
  const simulation = { getSnapshot: () => snapshot };
  const session = withSimulationDrawings(repository, simulation);
  return {
    session,
    repository,
    loadDrawings,
    saveDrawings,
    loadCandles,
    simulation,
    setStatus: (status: SimulationSnapshot['status']) => {
      snapshot = { ...snapshot, status };
    },
  };
}

describe('simulation drawing storage', () => {
  test('starts empty and retains drawings for chart reloads without changing instrument drawings', async () => {
    const { session, repository, loadDrawings, saveDrawings, setStatus } =
      setup();
    expect(await session.loadDrawings('gold')).toBeUndefined();
    await session.saveDrawings('gold', sessionDrawings);
    expect(await session.loadDrawings('gold')).toBe(sessionDrawings);
    setStatus('paused');
    expect(await session.loadDrawings('gold')).toBe(sessionDrawings);
    expect(loadDrawings).not.toHaveBeenCalled();
    expect(saveDrawings).not.toHaveBeenCalled();
    expect(await repository.loadDrawings('gold')).toBe(historicalDrawings);
  });

  test('a new session never inherits an old session or its late cleanup save', async () => {
    const { session: first, repository } = setup();
    await first.saveDrawings('gold', sessionDrawings);
    const second = withSimulationDrawings(repository, setup().simulation);
    expect(await second.loadDrawings('gold')).toBeUndefined();
    await first.saveDrawings('gold', '[{"id":"late-cleanup"}]');
    expect(await second.loadDrawings('gold')).toBeUndefined();
    await second.saveDrawings('gold', '[{"id":"new-session"}]');
    expect(await second.loadDrawings('gold')).toBe('[{"id":"new-session"}]');
    expect(await repository.loadDrawings('gold')).toBe(historicalDrawings);
  });

  test('restores saved session drawings without loading permanent instrument drawings', async () => {
    const { repository, simulation, loadDrawings, saveDrawings, setStatus } =
      setup();
    setStatus('paused');
    const restored = withSimulationDrawings(
      repository,
      simulation,
      sessionDrawings,
    );
    expect(await restored.loadDrawings('gold')).toBe(sessionDrawings);
    setStatus('playing');
    expect(await restored.loadDrawings('gold')).toBe(sessionDrawings);
    setStatus('finished');
    expect(await restored.loadDrawings('gold')).toBeUndefined();
    expect(loadDrawings).not.toHaveBeenCalled();
    expect(saveDrawings).not.toHaveBeenCalled();
  });

  test.each(['finished', 'error'] as const)(
    'clears %s sessions and rejects delayed autosave resurrection',
    async (status) => {
      const { session, setStatus, saveDrawings } = setup();
      await session.saveDrawings('gold', sessionDrawings);
      setStatus(status);
      expect(await session.loadDrawings('gold')).toBeUndefined();
      await session.saveDrawings('gold', sessionDrawings);
      expect(await session.loadDrawings('gold')).toBeUndefined();
      expect(saveDrawings).not.toHaveBeenCalled();
    },
  );

  test('keeps market history requests unchanged', async () => {
    const { session, loadCandles } = setup();
    await session.loadCandles('dataset', '5m', 1000, 800, undefined, 500);
    expect(loadCandles).toHaveBeenCalledWith(
      'dataset',
      '5m',
      1000,
      800,
      undefined,
      500,
    );
  });
});
