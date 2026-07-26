import type { CanvasView } from "./drawing-renderer";

export interface GestureMetrics {
  centerX: number;
  centerY: number;
  distance: number;
}

export interface GestureAnchor {
  gestureCenterX: number;
  gestureCenterY: number;
  distance: number;
  zoom: number;
  cameraCenterX: number;
  cameraCenterY: number;
  viewportCenterX: number;
  viewportCenterY: number;
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
    gestureCenterX: metrics.centerX,
    gestureCenterY: metrics.centerY,
    distance: metrics.distance,
    zoom: view.zoom,
    cameraCenterX: view.centerX,
    cameraCenterY: view.centerY,
    viewportCenterX: transform.panX + view.centerX * transform.zoom,
    viewportCenterY: transform.panY + view.centerY * transform.zoom,
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
    centerX: anchor.sceneX - (metrics.centerX - anchor.viewportCenterX) / (anchor.fitScale * zoom),
    centerY: anchor.sceneY - (metrics.centerY - anchor.viewportCenterY) / (anchor.fitScale * zoom),
  };
}
