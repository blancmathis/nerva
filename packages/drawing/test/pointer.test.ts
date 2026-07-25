import { describe, expect, it, vi } from "vitest";

import {
  PencilPointerTracker,
  pointerKindOf,
  pointerSamples,
  sceneToViewportPoint,
  viewportToScenePoint,
  type PointerCaptureTargetLike,
  type PointerEventLike,
} from "../src/pointer.js";
import type { ScenePoint, ViewTransform } from "../src/types.js";

const identity: ViewTransform = { panX: 0, panY: 0, zoom: 1 };

function pointer(
  overrides: Partial<PointerEventLike> = {},
): PointerEventLike {
  return {
    pointerId: 1,
    pointerType: "pen",
    clientX: 10,
    clientY: 20,
    pressure: 0.7,
    tiltX: 12,
    tiltY: -8,
    timeStamp: 100,
    ...overrides,
  };
}

function captureTarget() {
  const captured = new Set<number>();
  const setPointerCapture = vi.fn((pointerId: number) => captured.add(pointerId));
  const releasePointerCapture = vi.fn((pointerId: number) => captured.delete(pointerId));
  const hasPointerCapture = vi.fn((pointerId: number) => captured.has(pointerId));
  const target: PointerCaptureTargetLike = {
    setPointerCapture,
    releasePointerCapture,
    hasPointerCapture,
  };

  return { target, setPointerCapture, releasePointerCapture, captured };
}

describe("coordinate transforms", () => {
  it("round-trips coordinates while preserving Pencil metadata", () => {
    const point: ScenePoint = {
      x: 130,
      y: 45,
      pressure: 0.83,
      tiltX: 14,
      tiltY: -22,
      time: 900,
      pointerType: "pen",
    };
    const transform: ViewTransform = { panX: 30, panY: -5, zoom: 2 };

    const scenePoint = viewportToScenePoint(point, transform);
    expect(scenePoint).toEqual({ ...point, x: 50, y: 25 });
    expect(sceneToViewportPoint(scenePoint, transform)).toEqual(point);
  });

  it("rejects invalid zoom values", () => {
    const point: ScenePoint = {
      x: 0,
      y: 0,
      pressure: 0,
      tiltX: 0,
      tiltY: 0,
      time: 0,
      pointerType: "mouse",
    };

    expect(() => viewportToScenePoint(point, { panX: 0, panY: 0, zoom: 0 })).toThrow(
      /zoom/,
    );
  });
});

describe("pointerSamples", () => {
  it("uses coalesced events but includes the dispatch sample exactly once", () => {
    const early = pointer({ clientX: 12, clientY: 24, timeStamp: 101 });
    let final: PointerEventLike;
    final = pointer({
      clientX: 18,
      clientY: 30,
      timeStamp: 102,
      getCoalescedEvents: () => [early, final],
    });

    const points = pointerSamples(final, { panX: 2, panY: 10, zoom: 2 });

    expect(points).toHaveLength(2);
    expect(points.map(({ x, y, time }) => ({ x, y, time }))).toEqual([
      { x: 5, y: 7, time: 101 },
      { x: 8, y: 10, time: 102 },
    ]);
    expect(points[0]).toMatchObject({
      pressure: 0.7,
      tiltX: 12,
      tiltY: -8,
      pointerType: "pen",
    });
  });

  it("falls back to the dispatch event when coalesced samples are unavailable or throw", () => {
    const withoutApi = pointer();
    const throwing = pointer({
      clientX: 33,
      getCoalescedEvents: () => {
        throw new Error("WebKit synthetic event");
      },
    });

    expect(pointerSamples(withoutApi, identity)).toHaveLength(1);
    expect(pointerSamples(throwing, identity)).toMatchObject([{ x: 33 }]);
  });

  it("normalizes unknown pointer devices to mouse and clamps sensor values", () => {
    const event = pointer({
      pointerType: "future-device",
      pressure: 3,
      tiltX: -100,
      tiltY: 120,
    });

    expect(pointerKindOf(event)).toBe("mouse");
    expect(pointerSamples(event, identity)[0]).toMatchObject({
      pressure: 1,
      tiltX: -90,
      tiltY: 90,
      pointerType: "mouse",
    });
  });
});

describe("PencilPointerTracker", () => {
  it("captures an accepted pointer and releases it on pointer up", () => {
    const tracker = new PencilPointerTracker();
    const target = captureTarget();
    const preventDefault = vi.fn();
    const event = pointer({ pointerId: 7, preventDefault });

    const down = tracker.pointerDown(event, target.target, identity);
    expect(down.accepted).toBe(true);
    expect(down.points).toHaveLength(1);
    expect(target.setPointerCapture).toHaveBeenCalledWith(7);
    expect(target.captured.has(7)).toBe(true);

    const up = tracker.pointerUp(event, identity);
    expect(up.accepted).toBe(true);
    expect(target.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(target.captured.has(7)).toBe(false);
    expect(tracker.isActive(7)).toBe(false);
    expect(preventDefault).toHaveBeenCalledTimes(2);
  });

  it("cancels and releases accepted touches when a pen begins", () => {
    const cancelled = vi.fn();
    const tracker = new PencilPointerTracker({ onPointerCancelled: cancelled });
    const touchTarget = captureTarget();
    const penTarget = captureTarget();
    const touch = pointer({ pointerId: 10, pointerType: "touch" });
    const pen = pointer({ pointerId: 20, pointerType: "pen" });

    expect(tracker.pointerDown(touch, touchTarget.target, identity).accepted).toBe(true);
    const result = tracker.pointerDown(pen, penTarget.target, identity);

    expect(result).toMatchObject({ accepted: true, cancelledPointerIds: [10] });
    expect(touchTarget.releasePointerCapture).toHaveBeenCalledWith(10);
    expect(cancelled).toHaveBeenCalledWith(10);
    expect(tracker.activePointerIds("touch")).toEqual([]);
    expect(tracker.activePointerIds("pen")).toEqual([20]);
    expect(tracker.pointerMove(touch, identity).accepted).toBe(false);
  });

  it("ignores touch as palm input while any pen pointer is active", () => {
    const tracker = new PencilPointerTracker();
    const penTarget = captureTarget();
    const touchTarget = captureTarget();
    const pen = pointer({ pointerId: 2, pointerType: "pen" });
    const touch = pointer({ pointerId: 3, pointerType: "touch" });

    tracker.pointerDown(pen, penTarget.target, identity);
    const result = tracker.pointerDown(touch, touchTarget.target, identity);

    expect(result).toEqual({ accepted: false, points: [], cancelledPointerIds: [] });
    expect(touchTarget.setPointerCapture).not.toHaveBeenCalled();
    expect(tracker.isActive(3)).toBe(false);
  });

  it("releases an accepted pointer on cancel and all remaining pointers on teardown", () => {
    const tracker = new PencilPointerTracker();
    const firstTarget = captureTarget();
    const secondTarget = captureTarget();
    const first = pointer({ pointerId: 4, pointerType: "mouse" });
    const second = pointer({ pointerId: 5, pointerType: "pen" });

    tracker.pointerDown(first, firstTarget.target, identity);
    expect(tracker.pointerCancel(first).accepted).toBe(true);
    expect(firstTarget.releasePointerCapture).toHaveBeenCalledWith(4);

    tracker.pointerDown(second, secondTarget.target, identity);
    tracker.releaseAll();
    expect(secondTarget.releasePointerCapture).toHaveBeenCalledWith(5);
    expect(tracker.activePointerIds()).toEqual([]);
  });

  it("tolerates pointer-capture methods that race and throw", () => {
    const tracker = new PencilPointerTracker();
    const target: PointerCaptureTargetLike = {
      setPointerCapture: () => {
        throw new DOMException("gone");
      },
      releasePointerCapture: () => {
        throw new DOMException("gone");
      },
    };
    const event = pointer();

    expect(tracker.pointerDown(event, target, identity).accepted).toBe(true);
    expect(tracker.pointerUp(event, identity).accepted).toBe(true);
  });
});
