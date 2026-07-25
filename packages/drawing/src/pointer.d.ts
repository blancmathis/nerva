import type { PointerKind, ScenePoint, ViewTransform } from "./types.js";
/**
 * The subset of PointerEvent used by the drawing engine. Keeping this
 * structural makes the input pipeline testable without a browser DOM.
 */
export interface PointerEventLike {
    readonly pointerId: number;
    readonly pointerType?: string;
    readonly clientX: number;
    readonly clientY: number;
    readonly pressure?: number;
    readonly tiltX?: number;
    readonly tiltY?: number;
    readonly timeStamp?: number;
    getCoalescedEvents?: () => readonly PointerEventLike[];
    preventDefault?: () => void;
}
/** The pointer-capture subset implemented by Element. */
export interface PointerCaptureTargetLike {
    setPointerCapture?: (pointerId: number) => void;
    releasePointerCapture?: (pointerId: number) => void;
    hasPointerCapture?: (pointerId: number) => boolean;
}
export interface PointerTrackingResult {
    readonly accepted: boolean;
    readonly points: readonly ScenePoint[];
    readonly cancelledPointerIds: readonly number[];
}
export interface PencilPointerTrackerOptions {
    /** Called after an accepted touch is cancelled because Pencil input began. */
    readonly onPointerCancelled?: (pointerId: number) => void;
}
export declare function pointerKindOf(event: Pick<PointerEventLike, "pointerType">): PointerKind;
export declare function viewportToScenePoint(point: ScenePoint, transform: ViewTransform): ScenePoint;
export declare function sceneToViewportPoint(point: ScenePoint, transform: ViewTransform): ScenePoint;
/**
 * Returns coalesced samples followed by the dispatch event. Safari and other
 * browsers sometimes include the dispatch event in getCoalescedEvents(); it is
 * removed before the explicit final append so callers never draw it twice.
 */
export declare function pointerSamples(event: PointerEventLike, transform: ViewTransform, fallbackKind?: PointerKind): readonly ScenePoint[];
/**
 * Coordinates Pointer Events for a Pencil-first canvas. Accepted pointers are
 * captured until up/cancel. Touch is treated as palm input while any pen is
 * active; a newly arriving pen also cancels and releases accepted touches.
 */
export declare class PencilPointerTracker {
    #private;
    constructor(options?: PencilPointerTrackerOptions);
    pointerDown(event: PointerEventLike, target: PointerCaptureTargetLike, transform: ViewTransform): PointerTrackingResult;
    pointerMove(event: PointerEventLike, transform: ViewTransform): PointerTrackingResult;
    pointerUp(event: PointerEventLike, transform: ViewTransform): PointerTrackingResult;
    pointerCancel(event: Pick<PointerEventLike, "pointerId" | "preventDefault">): PointerTrackingResult;
    isActive(pointerId: number): boolean;
    activePointerIds(kind?: PointerKind): readonly number[];
    releaseAll(): void;
}
