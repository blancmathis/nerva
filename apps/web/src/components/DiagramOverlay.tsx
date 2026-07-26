import type { Scene } from "@codex-pad/drawing";
import type { DiagramDocument, DiagramNode } from "@codex-pad/protocol";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

import {
  measureCanvas,
  type CanvasView,
} from "./drawing-renderer";
import { updateDiagramNode } from "../lib/diagram-model";

interface OverlayMetrics {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

interface NodeGesture {
  readonly pointerId: number;
  readonly nodeId: string;
  readonly mode: "move" | "resize";
  readonly startClientX: number;
  readonly startClientY: number;
  readonly startNode: DiagramNode;
  readonly original: DiagramDocument;
  changed: boolean;
}

export interface DiagramOverlayProps {
  readonly diagram: DiagramDocument;
  readonly scene: Scene;
  readonly view: CanvasView;
  readonly canvasRef: RefObject<HTMLCanvasElement | null>;
  readonly active: boolean;
  readonly readOnly: boolean;
  readonly selectedNodeId: string | null;
  readonly onSelectNode: (nodeId: string) => void;
  readonly onPreview: (diagram: DiagramDocument) => void;
  readonly onCommit: (previous: DiagramDocument) => void;
}

function canvasMetrics(
  canvas: HTMLCanvasElement,
  scene: Scene,
  view: CanvasView,
): OverlayMetrics {
  const metrics = measureCanvas(canvas, scene);
  const scale = metrics.fitScale * view.zoom;
  return {
    scale,
    offsetX: metrics.width / 2 - view.centerX * scale,
    offsetY: metrics.height / 2 - view.centerY * scale,
  };
}

export function DiagramOverlay({
  diagram,
  scene,
  view,
  canvasRef,
  active,
  readOnly,
  selectedNodeId,
  onSelectNode,
  onPreview,
  onCommit,
}: DiagramOverlayProps) {
  const [metrics, setMetrics] = useState<OverlayMetrics | null>(null);
  const gestureRef = useRef<NodeGesture | null>(null);
  const diagramRef = useRef(diagram);
  diagramRef.current = diagram;

  const refreshMetrics = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setMetrics(canvasMetrics(canvas, scene, view));
  }, [canvasRef, scene, view]);

  useEffect(() => {
    refreshMetrics();
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", refreshMetrics);
      return () => window.removeEventListener("resize", refreshMetrics);
    }
    const observer = new ResizeObserver(refreshMetrics);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [canvasRef, refreshMetrics]);

  const begin = useCallback((
    event: ReactPointerEvent<HTMLDivElement>,
    node: DiagramNode,
    mode: NodeGesture["mode"],
  ) => {
    if (!active || readOnly || !metrics || event.button > 0) return;
    event.preventDefault();
    event.stopPropagation();
    onSelectNode(node.id);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* WebKit may cancel a palm. */ }
    gestureRef.current = {
      pointerId: event.pointerId,
      nodeId: node.id,
      mode,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startNode: node,
      original: diagramRef.current,
      changed: false,
    };
  }, [active, metrics, onSelectNode, readOnly]);

  const move = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || !metrics) return;
    event.preventDefault();
    event.stopPropagation();
    const dx = (event.clientX - gesture.startClientX) / metrics.scale;
    const dy = (event.clientY - gesture.startClientY) / metrics.scale;
    const update = gesture.mode === "move"
      ? {
          x: gesture.startNode.x + dx,
          y: gesture.startNode.y + dy,
        }
      : {
          width: Math.min(520, Math.max(120, gesture.startNode.width + dx)),
          height: Math.min(260, Math.max(64, gesture.startNode.height + dy)),
        };
    const next = updateDiagramNode(diagramRef.current, gesture.nodeId, update);
    gesture.changed = true;
    onPreview(next);
  }, [metrics, onPreview]);

  const end = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    gestureRef.current = null;
    if (gesture.changed) onCommit(gesture.original);
  }, [onCommit]);

  if (!metrics) return null;

  return (
    <div
      className={`diagram-overlay${active ? " is-active" : ""}`}
      aria-hidden={!active}
    >
      {diagram.nodes.map((node) => {
        const selected = selectedNodeId === node.id;
        return (
          <div
            key={node.id}
            className={`diagram-node-hitbox${selected ? " is-selected" : ""}`}
            style={{
              left: metrics.offsetX + node.x * metrics.scale,
              top: metrics.offsetY + node.y * metrics.scale,
              width: node.width * metrics.scale,
              height: node.height * metrics.scale,
              borderRadius: node.shape === "ellipse" ? "999px" : undefined,
            }}
            role="button"
            aria-label={`Edit diagram block ${node.label}`}
            aria-pressed={selected}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelectNode(node.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectNode(node.id);
              }
            }}
            onPointerDown={(event) => begin(event, node, "move")}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onLostPointerCapture={end}
          >
            <span className="diagram-node-hitbox__grip" aria-hidden="true">···</span>
            <div
              className="diagram-node-hitbox__resize"
              aria-hidden="true"
              onPointerDown={(event) => begin(event, node, "resize")}
              onPointerMove={move}
              onPointerUp={end}
              onPointerCancel={end}
              onLostPointerCapture={end}
            />
          </div>
        );
      })}
    </div>
  );
}
