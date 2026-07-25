import type { CanvasView } from "./drawing-renderer";

export interface GestureMetrics {
  centerX: number;
  centerY: number;
  distance: number;
}

export interface GestureAnchor extends GestureMetrics {
  zoom: number;
  panX: number;
  panY: number;
  baseX: number;
  baseY: number;
  fitScale: number;
  sceneX: number;
  sceneY: number;
}

export function createGestureAnchor(
  metrics: GestureMetrics,
  view: CanvasView,
  transform: { zoom: number; panX: number; panY: number },
): GestureAnchor {
  const fitScale = transform.zoom / view.zoom;
  return {
    ...metrics,
    ...view,
    baseX: transform.panX - view.panX,
    baseY: transform.panY - view.panY,
    fitScale,
    sceneX: (metrics.centerX - transform.panX) / transform.zoom,
    sceneY: (metrics.centerY - transform.panY) / transform.zoom,
  };
}

export function solvePinchView(
  anchor: GestureAnchor,
  metrics: GestureMetrics,
  minimumZoom: number,
  maximumZoom: number,
): CanvasView {
  const zoom = Math.min(
    maximumZoom,
    Math.max(minimumZoom, anchor.zoom * (metrics.distance / anchor.distance)),
  );
  return {
    zoom,
    panX: metrics.centerX - anchor.baseX - anchor.sceneX * anchor.fitScale * zoom,
    panY: metrics.centerY - anchor.baseY - anchor.sceneY * anchor.fitScale * zoom,
  };
}

