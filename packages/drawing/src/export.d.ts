import { type CropOptions, type ExportGeometry } from "./geometry.js";
import { type ImportedImageSource, type Scene } from "./types.js";
export type CanvasSurface = HTMLCanvasElement | OffscreenCanvas;
export type CanvasFactory = (width: number, height: number) => CanvasSurface;
export type ImageResolver = (source: ImportedImageSource) => Promise<CanvasImageSource>;
export type ExportBackground = "scene" | "transparent" | "white" | "dark";
export interface PngExportOptions extends CropOptions {
    readonly background?: ExportBackground;
    readonly canvasFactory?: CanvasFactory;
    readonly imageResolver?: ImageResolver;
}
export interface RenderedScene {
    readonly canvas: CanvasSurface;
    readonly geometry: ExportGeometry;
}
export declare class CanvasUnavailableError extends Error {
    constructor(message?: string);
}
export declare class ImageSourceUnavailableError extends Error {
    constructor(message: string);
}
/** Render a flattened scene. Geometry-only APIs remain available when Canvas is absent. */
export declare function renderSceneToCanvas(scene: Scene, options?: PngExportOptions): Promise<RenderedScene>;
export declare function exportSceneToPng(scene: Scene, options?: PngExportOptions): Promise<Blob>;
