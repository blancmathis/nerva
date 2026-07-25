import type { Bounds, EraserElement, Point2D, Scene, SceneElement, ShapeElement, StrokeElement, TextElement } from "./types.js";
export declare const HARD_MAX_EXPORT_DIMENSION = 8192;
export declare const HARD_MAX_EXPORT_PIXELS: number;
export interface FreehandOptions {
    readonly size: number;
    readonly thinning: number;
    readonly smoothing: number;
    readonly streamline: number;
    readonly simulatePressure: boolean;
    readonly last: boolean;
    readonly start: {
        readonly cap: boolean;
    };
    readonly end: {
        readonly cap: boolean;
    };
}
export interface CropOptions {
    readonly padding?: number;
    /** Final physical pixels, clamped to HARD_MAX_EXPORT_DIMENSION. */
    readonly maxWidth?: number;
    /** Final physical pixels, clamped to HARD_MAX_EXPORT_DIMENSION. */
    readonly maxHeight?: number;
    readonly pixelRatio?: number;
    readonly includeErasersInBounds?: boolean;
}
export interface ExportGeometry {
    readonly bounds: Bounds;
    readonly width: number;
    readonly height: number;
    /** Scene units to final physical pixels. */
    readonly scale: number;
    readonly offsetX: number;
    readonly offsetY: number;
    readonly padding: number;
}
export declare function scenePointToExport(point: Point2D, geometry: ExportGeometry): Point2D;
export declare function normalizedElementOutline(element: SceneElement, geometry: ExportGeometry): readonly Point2D[];
export declare function freehandOptionsFor(element: StrokeElement | EraserElement): FreehandOptions;
export declare function rotatePoint(point: Point2D, center: Point2D, radians: number): Point2D;
export declare function getStrokePolygon(element: StrokeElement | EraserElement): readonly Point2D[];
export declare function getArrowPolygon(element: ShapeElement): readonly Point2D[];
export declare function estimateTextSize(element: TextElement): {
    readonly width: number;
    readonly height: number;
};
export declare function getElementOutline(element: SceneElement): readonly Point2D[];
export declare function boundsFromPoints(points: readonly Point2D[]): Bounds;
export declare function getElementBounds(element: SceneElement): Bounds;
export declare function unionBounds(bounds: readonly Bounds[]): Bounds;
export declare function getSceneBounds(scene: Scene, options?: {
    readonly includeErasers?: boolean;
}): Bounds;
export declare function polygonToSvgPath(polygon: readonly Point2D[]): string;
export declare function elementToSvgPath(element: SceneElement): string;
export declare function createExportGeometry(scene: Scene, options?: CropOptions): ExportGeometry;
