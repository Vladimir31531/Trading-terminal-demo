import {
  applyDrag,
  type Coords,
  type Drawing,
  type DrawingManager,
  hitTestKind,
  type Pt,
} from 'lightweight-charts-drawing';

type PaneSize = { width: number; height: number };

function projectDrawing(drawing: Drawing, coords: Coords): Pt[] | null {
  if (
    drawing.kind !== 'horizontal-line' &&
    drawing.kind !== 'vertical-line' &&
    drawing.kind !== 'rectangle'
  )
    return null;
  const points: Pt[] = [];
  for (const point of drawing.points) {
    // Full-pane lines remain visible when their irrelevant anchor axis is not.
    const x =
      coords.timeToX(point.time) ??
      (drawing.kind === 'horizontal-line' ? 0 : null);
    const y =
      coords.priceToY(point.price) ??
      (drawing.kind === 'vertical-line' ? 0 : null);
    if (x === null || y === null) return null;
    points.push({ x, y });
  }
  return points;
}

export function findDrawingAt(
  manager: Pick<DrawingManager, 'drawings' | 'drawingsVisible' | 'selection'>,
  coords: Coords,
  cursor: Pt,
  pane: PaneSize,
): Drawing | undefined {
  if (
    !manager.drawingsVisible() ||
    cursor.x < 0 ||
    cursor.y < 0 ||
    cursor.x > pane.width ||
    cursor.y > pane.height
  )
    return undefined;
  const drawings = manager.drawings();
  const selected = manager.selection();
  for (let index = drawings.length - 1; index >= 0; index--) {
    const drawing = drawings[index];
    if (drawing.hidden) continue;
    const points = projectDrawing(drawing, coords);
    if (
      points &&
      hitTestKind(
        drawing,
        points,
        cursor,
        pane.width,
        pane.height,
        coords,
        selected.includes(drawing.id),
      )
    )
      return drawing;
  }
  return undefined;
}

export function prepareDrawingCopy(
  source: Drawing,
  cursor: Pt,
  coords: Coords,
  pane: PaneSize,
) {
  const startScreen = projectDrawing(source, coords);
  if (!startScreen) return undefined;
  const start: Drawing = {
    ...structuredClone(source),
    id: crypto.randomUUID(),
  };
  // Keep the unused coordinate of a full-pane line, including off-screen anchors.
  const dragCoords =
    source.kind === 'horizontal-line'
      ? { ...coords, xToTime: () => source.points[0].time }
      : source.kind === 'vertical-line'
        ? { ...coords, yToPrice: () => source.points[0].price }
        : coords;
  return {
    id: start.id,
    move: (next: Pt): Drawing | null =>
      applyDrag(
        {
          id: start.id,
          start,
          startCursor: { ...cursor },
          startScreen,
          mode: { hit: 'body' },
          active: true,
          pane: { w: pane.width, h: pane.height },
        },
        next,
        dragCoords,
        (point) => point,
      ),
  };
}
