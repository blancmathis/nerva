import type {
  SiteQaInputEvidence,
  SiteQaManifest,
  SiteQaTargetDescriptor,
} from "@codex-pad/protocol";

export interface SiteQaManifestStep {
  readonly stepId: string;
  readonly index: number;
  readonly relativeAtMs: number;
  readonly action:
    | { readonly type: "tap"; readonly x: number; readonly y: number }
    | { readonly type: "scroll"; readonly x: number; readonly y: number; readonly deltaX: number; readonly deltaY: number }
    | { readonly type: "insertText" }
    | { readonly type: "navigate" }
    | { readonly type: "key"; readonly key: "Enter" | "Backspace" | "Escape" | "Tab" }
    | { readonly type: "back" | "forward" | "reload" };
  readonly target: SiteQaTargetDescriptor | null;
  readonly input: SiteQaInputEvidence;
  readonly beforeUrl: string;
  readonly afterUrl: string;
  readonly confidence: "high" | "medium" | "coordinate-only";
  readonly evidenceFrameId: string;
}

export interface SiteQaOutboundFrame {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
  readonly scrollX: number;
  readonly scrollY: number;
}

export interface SiteQaSendPayload {
  readonly manifest: SiteQaManifest;
  readonly frames: readonly SiteQaOutboundFrame[];
}

export interface SiteQaSendResult {
  readonly ok: boolean;
  readonly pending?: boolean;
  readonly message: string;
}
