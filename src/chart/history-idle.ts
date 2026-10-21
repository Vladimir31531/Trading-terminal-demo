interface HistoryRange {
  from: number;
  to: number;
}

interface FrameScheduler {
  request(callback: () => void): number;
  cancel(id: number): void;
}

/** Wait until a gesture and its remaining scroll animation have settled. */
export function waitForHistoryIdle(
  getRange: () => HistoryRange | null,
  isInteracting: () => boolean,
  scheduler: FrameScheduler = {
    request: (callback) => requestAnimationFrame(callback),
    cancel: (id) => cancelAnimationFrame(id),
  },
): { ready: Promise<boolean>; cancel(): void } {
  let previous: HistoryRange | null = null;
  let frame: number | undefined;
  let completed = false;
  let resolveReady: (ready: boolean) => void;
  const ready = new Promise<boolean>((resolve) => {
    resolveReady = resolve;
  });

  const finish = (value: boolean) => {
    if (completed) return;
    completed = true;
    if (frame !== undefined) scheduler.cancel(frame);
    frame = undefined;
    resolveReady(value);
  };
  const sample = () => {
    if (completed) return;
    frame = undefined;
    const range = isInteracting() ? null : getRange();
    if (
      range &&
      previous &&
      range.from === previous.from &&
      range.to === previous.to
    ) {
      finish(true);
      return;
    }
    previous = range ? { ...range } : null;
    frame = scheduler.request(sample);
  };
  frame = scheduler.request(sample);
  return { ready, cancel: () => finish(false) };
}
