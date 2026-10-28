import { useCallback, useEffect, useRef } from 'react';
import type { SimulationEngine } from '../application/simulation-engine';

/** Keyboard controls follow the active simulation across application pages. */
export function useSimulationShortcuts(
  engine?: SimulationEngine,
  busy = false,
): () => void {
  const originalSpeed = useRef<number | undefined>(undefined);
  const restoreSpeed = useCallback(() => {
    const previous = originalSpeed.current;
    if (previous === undefined) return;
    originalSpeed.current = undefined;
    engine?.setSpeed(previous);
  }, [engine]);

  useEffect(() => {
    if (!engine || busy) return;
    let spacePressed = false;
    const editing = (target: EventTarget | null) =>
      target instanceof Element &&
      target.closest(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="alertdialog"]',
      );
    const down = (event: KeyboardEvent) => {
      const space = event.code === 'Space' || event.key === ' ';
      if (event.key !== 'ArrowRight' && !space) return;
      const { status } = engine.getSnapshot();
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        event.shiftKey ||
        editing(event.target) ||
        status === 'finished' ||
        status === 'error'
      )
        return;
      if (space) {
        event.preventDefault();
        if (event.repeat || spacePressed) return;
        spacePressed = true;
        if (status === 'paused') engine.play();
        else engine.pause();
        return;
      }
      if (originalSpeed.current === undefined) {
        if (event.repeat) return;
        originalSpeed.current = engine.getSnapshot().speed;
        engine.setSpeed(10_000);
      }
      event.preventDefault();
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight') restoreSpeed();
      if ((event.code === 'Space' || event.key === ' ') && spacePressed) {
        event.preventDefault();
        spacePressed = false;
      }
    };
    const reset = () => {
      spacePressed = false;
      restoreSpeed();
    };
    const visibility = () => {
      if (document.hidden) reset();
    };
    const focus = (event: FocusEvent) => {
      if (editing(event.target)) restoreSpeed();
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('focusin', focus);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', reset);
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('focusin', focus);
      reset();
    };
  }, [engine, busy, restoreSpeed]);

  return restoreSpeed;
}
