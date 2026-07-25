import { createScene, type Scene } from "@codex-pad/drawing";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";

import { PHOTO_IMPORT_ACCEPT } from "../lib/heic-image";
import {
  deleteCaptureInboxItems,
  listCaptureInboxItems,
  loadCaptureInboxItem,
  saveCaptureInboxItem,
  type CaptureInboxItem,
  type CaptureKind,
} from "../lib/capture-inbox-store";
import { captureCanUseInReview, useCaptureInboxInReview } from "../lib/capture-review";
import { formatReviewBytes } from "../lib/review-media";
import type { ProductSession } from "../lib/session-presentation";
import { DrawingCanvasEditor } from "./DrawingStudio";
import { exportSceneToBoundedPng } from "./drawing-export";
import {
  CameraIcon,
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  DocumentIcon,
  FolderIcon,
  InboxIcon,
  NoteIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
} from "./Icons";

interface CaptureInboxPageProps {
  readonly targetSession: ProductSession | null;
  readonly macUnavailable: boolean;
  readonly onUseInSession: (threadId: string) => void;
  readonly onBackToSession: () => void;
  readonly onBusyChange?: (busy: boolean) => void;
}

const SKETCH_WIDTH = 1_440;
const SKETCH_HEIGHT = 900;

function captureTitle(kind: CaptureKind, now = new Date()): string {
  const label = kind === "scan" ? "Scan" : kind === "sketch" ? "Sketch" : kind === "photo" ? "Photo" : "Capture";
  return `${label} · ${new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(now)}`;
}

function formatAge(value: number): string {
  const elapsed = Math.max(0, Date.now() - value);
  if (elapsed < 60_000) return "Just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(value);
}

function kindLabel(kind: CaptureKind): string {
  if (kind === "file") return "File";
  if (kind === "note") return "Quick note";
  return kind[0]!.toUpperCase() + kind.slice(1);
}

function kindIcon(kind: CaptureKind) {
  if (kind === "photo") return <CameraIcon />;
  if (kind === "scan") return <DocumentIcon />;
  if (kind === "sketch") return <PencilIcon />;
  if (kind === "file") return <FolderIcon />;
  return <NoteIcon />;
}

function useCaptureObjectUrl(item: CaptureInboxItem): string | null {
  const [source, setSource] = useState<string | null>(null);
  const previewable = Boolean(item.mimeType?.startsWith("image/") || item.mimeType?.startsWith("audio/"));
  useEffect(() => {
    if (!previewable) {
      setSource(null);
      return;
    }
    let active = true;
    let objectUrl: string | null = null;
    void loadCaptureInboxItem(item.id).then((loaded) => {
      if (!active || !loaded?.blob) return;
      objectUrl = URL.createObjectURL(loaded.blob);
      setSource(objectUrl);
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [item.id, previewable]);
  return source;
}

function notePreviewText(item: CaptureInboxItem): string {
  const note = item.text?.trim() ?? "";
  const title = item.title.trim().replace(/…$/u, "");
  if (!note || !title || !note.startsWith(title)) return note;

  let bodyStart = title.length;
  if (bodyStart < note.length && /\S/u.test(title.at(-1) ?? "") && /\S/u.test(note[bodyStart] ?? "")) {
    const lastWordStart = title.lastIndexOf(" ");
    if (lastWordStart >= 0) bodyStart = lastWordStart + 1;
  }
  const body = note.slice(bodyStart).trim().replace(/^[\s,.;:!?—-]+/u, "");
  return body || note;
}

function CapturePreview({ item }: { readonly item: CaptureInboxItem }) {
  const source = useCaptureObjectUrl(item);
  if (source && item.mimeType?.startsWith("image/")) {
    return <img src={source} alt="" draggable={false} />;
  }
  if (source && item.mimeType?.startsWith("audio/")) {
    return (
      <div className="cp-capture-card__audio">
        <span className="cp-capture-wave" aria-hidden="true">{Array.from({ length: 18 }, (_, index) => <i key={index} />)}</span>
        <audio controls preload="metadata" src={source} aria-label={`Play ${item.title}`} />
      </div>
    );
  }
  if (item.kind === "note") {
    return <p className="cp-capture-card__note">{notePreviewText(item)}</p>;
  }
  return <span className={`cp-capture-card__glyph kind-${item.kind}`} aria-hidden="true">{kindIcon(item.kind)}</span>;
}

function CaptureAction({ icon, label, detail, onClick }: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly detail: string;
  readonly onClick: () => void;
}) {
  return (
    <button type="button" className="cp-capture-action" onClick={onClick}>
      <span>{icon}</span><strong>{label}</strong><small>{detail}</small>
    </button>
  );
}

function QuickNoteSheet({ onSave, onClose }: { readonly onSave: (text: string) => Promise<void>; readonly onClose: () => void }) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <div className="cp-capture-modal-layer" role="presentation">
      <section className="cp-capture-sheet cp-quick-note" role="dialog" aria-modal="true" aria-labelledby="quick-note-title">
        <header><div><p className="cp-overline">Capture locally</p><h2 id="quick-note-title">Quick note</h2><p>Keep it here, then reuse it from any Session.</p></div><button type="button" className="cp-icon-button" aria-label="Close quick note" onClick={onClose}><CloseIcon /></button></header>
        <textarea autoFocus maxLength={20_000} value={text} onChange={(event) => setText(event.target.value)} placeholder="Write the thought before it disappears…" aria-label="Quick note text" />
        <footer><span>{text.length.toLocaleString("en")} / 20,000</span><button type="button" className="cp-secondary-button" onClick={onClose}>Cancel</button><button type="button" className="cp-capture-primary" disabled={!text.trim() || saving} onClick={() => { setSaving(true); void onSave(text).finally(() => setSaving(false)); }}>{saving ? "Saving…" : "Save to Inbox"}</button></footer>
      </section>
    </div>
  );
}

function SketchSheet({ onSave, onClose }: { readonly onSave: (scene: Scene) => Promise<void>; readonly onClose: () => void }) {
  const fresh = () => createScene({ width: SKETCH_WIDTH, height: SKETCH_HEIGHT, background: { mode: "white", color: "#151b20" } });
  const [scene, setScene] = useState<Scene>(fresh);
  const [pencilOnly, setPencilOnly] = useState(true);
  const [saving, setSaving] = useState(false);
  return (
    <div className="cp-capture-modal-layer cp-capture-modal-layer--full" role="presentation">
      <section className="cp-capture-sketch" role="dialog" aria-modal="true" aria-labelledby="capture-sketch-title">
        <header>
          <button type="button" className="cp-icon-button" aria-label="Close sketch" onClick={onClose}><CloseIcon /></button>
          <div><p className="cp-overline">Local sketch</p><h2 id="capture-sketch-title">Draw now. Use later.</h2></div>
          <div><button type="button" className="cp-capture-quiet" onClick={() => setPencilOnly((value) => !value)}>{pencilOnly ? "Pencil only" : "Finger + Pencil"}</button><button type="button" className="cp-capture-quiet" disabled={scene.elements.length === 0} onClick={() => setScene(fresh())}>Clear</button><button type="button" className="cp-capture-primary" disabled={scene.elements.length === 0 || saving} onClick={() => { setSaving(true); void onSave(scene).finally(() => setSaving(false)); }}>{saving ? "Saving…" : "Keep in Inbox"}</button></div>
        </header>
        <DrawingCanvasEditor scene={scene} onSceneChange={setScene} pencilOnly={pencilOnly} className="cp-capture-sketch__editor" />
        <p className="cp-capture-sketch__hint">{pencilOnly ? "Apple Pencil draws · two fingers move and zoom · your palm is ignored" : "Finger or Pencil draws · choose Move to navigate"}</p>
      </section>
    </div>
  );
}

export function CaptureInboxPage({ targetSession, macUnavailable, onUseInSession, onBackToSession, onBusyChange }: CaptureInboxPageProps) {
  const [items, setItems] = useState<readonly CaptureInboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selecting, setSelecting] = useState(targetSession !== null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [deletePendingIds, setDeletePendingIds] = useState<readonly string[] | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [sketchOpen, setSketchOpen] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const scanInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const busy = noteOpen
    || sketchOpen
    || preparing
    || deletePendingIds !== null;

  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  const refresh = useCallback(async () => {
    try {
      setItems(await listCaptureInboxItems());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Capture Inbox could not be opened.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    setSelectedIds(new Set());
    setSelecting(targetSession !== null);
  }, [targetSession?.threadId]);

  const selectedItems = items.filter((item) => selectedIds.has(item.id));
  const selectionCanUse = selectedItems.length > 0 && selectedItems.every(captureCanUseInReview);
  const totalBytes = items.reduce((total, item) => total + item.byteLength, 0);
  const visibleItems = items.filter((item) => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return true;
    return [item.title, item.fileName, item.text, kindLabel(item.kind)]
      .filter((value): value is string => Boolean(value))
      .join(" ")
      .toLocaleLowerCase()
      .includes(needle);
  });

  function clearSelection() {
    setSelecting(false);
    setSelectedIds(new Set());
  }

  function toggleSelection(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function saveLocalCapture(input: Parameters<typeof saveCaptureInboxItem>[0], message: string) {
    setError(null);
    try {
      await saveCaptureInboxItem(input);
      setNotice(message);
      await refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The capture could not be saved locally.");
      throw saveError;
    }
  }

  async function importFile(event: ChangeEvent<HTMLInputElement>, kind: "photo" | "scan" | "file") {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    await saveLocalCapture({
      kind,
      title: kind === "file" ? file.name : captureTitle(kind),
      blob: file,
      fileName: file.name,
    }, `${kindLabel(kind)} saved locally.`).catch(() => undefined);
  }

  async function useInSession() {
    if (!targetSession || !selectionCanUse || selectedItems.length === 0) return;
    setPreparing(true);
    setError(null);
    try {
      await useCaptureInboxInReview(selectedItems.map((item) => item.id), targetSession.threadId);
      clearSelection();
      onUseInSession(targetSession.threadId);
    } catch (preparationError) {
      setError(preparationError instanceof Error ? preparationError.message : "These captures could not be added to the local Review.");
    } finally {
      setPreparing(false);
    }
  }

  async function deletePendingCaptures() {
    if (!deletePendingIds || deletePendingIds.length === 0) return;
    const ids = [...deletePendingIds];
    try {
      await deleteCaptureInboxItems(ids);
      setNotice(`${ids.length} ${ids.length === 1 ? "capture" : "captures"} deleted from this iPad.`);
      setDeletePendingIds(null);
      setSelectedIds((current) => new Set([...current].filter((id) => !ids.includes(id))));
      await refresh();
    } catch (deleteError) {
      setDeletePendingIds(null);
      setError(deleteError instanceof Error ? deleteError.message : "The selected captures could not be deleted.");
    }
  }

  return (
    <main className="cp-capture-inbox">
      {targetSession && (
        <section className="cp-capture-session-context" aria-label={`Using Capture Inbox with ${targetSession.title}`}>
          <button type="button" onClick={onBackToSession}><ChevronIcon direction="left" />Session</button>
          <span><small>Using with</small><strong>{targetSession.title}</strong></span>
          <em>Local Review · nothing sent</em>
        </section>
      )}
      <header className="cp-capture-inbox__hero cp-enter">
        <div>
          <p className="cp-overline">Local context shelf</p>
          <h1>Capture Inbox</h1>
          <p>{targetSession ? "Choose the local context you want to use in this Session." : "Collect once. Reuse it later from any Session."}</p>
        </div>
        <div className="cp-capture-inbox__privacy"><span><InboxIcon /></span><strong>{items.length} {items.length === 1 ? "item" : "items"}</strong><small>{formatReviewBytes(totalBytes)} on this iPad</small><em>{macUnavailable ? "Mac offline is okay" : "Mac connected"}</em></div>
      </header>

      <section className="cp-capture-actions cp-enter cp-enter--2" aria-label="Create a local capture">
        <CaptureAction icon={<CameraIcon />} label="Photo" detail="Camera or library" onClick={() => photoInputRef.current?.click()} />
        <CaptureAction icon={<DocumentIcon />} label="Scan" detail="Capture a document" onClick={() => scanInputRef.current?.click()} />
        <CaptureAction icon={<PencilIcon />} label="Sketch" detail="Pencil-ready canvas" onClick={() => setSketchOpen(true)} />
        <CaptureAction icon={<FolderIcon />} label="File" detail="Keep a received file" onClick={() => fileInputRef.current?.click()} />
        <CaptureAction icon={<NoteIcon />} label="Note" detail="Catch a quick idea" onClick={() => setNoteOpen(true)} />
        <input ref={photoInputRef} aria-label="Capture photo" hidden type="file" accept={PHOTO_IMPORT_ACCEPT} capture="environment" onChange={(event) => void importFile(event, "photo")} />
        <input ref={scanInputRef} aria-label="Capture document scan" hidden type="file" accept={PHOTO_IMPORT_ACCEPT} capture="environment" onChange={(event) => void importFile(event, "scan")} />
        <input ref={fileInputRef} aria-label="Keep received file" hidden type="file" onChange={(event) => void importFile(event, "file")} />
      </section>

      <aside className="cp-capture-safety cp-enter cp-enter--2"><span><CheckIcon /></span><p><strong>Nothing leaves automatically.</strong> {targetSession ? `Selected items are copied into a local Review for ${targetSession.title}. Review still asks before delivery.` : "Open Capture Inbox from a Session when you want to use something. No assignment is stored."}</p></aside>

      <section className="cp-capture-library cp-enter cp-enter--3">
        <header className="cp-capture-toolbar">
          <label className="cp-capture-search"><SearchIcon /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search captures" aria-label="Search Capture Inbox" /></label>
          <button type="button" className="cp-capture-select" aria-pressed={selecting} disabled={items.length === 0} onClick={() => { if (selecting) clearSelection(); else setSelecting(true); }}>{selecting ? "Done" : "Select"}</button>
        </header>

        {notice && <p className="cp-capture-notice" role="status"><CheckIcon />{notice}<button type="button" aria-label="Dismiss message" onClick={() => setNotice(null)}><CloseIcon /></button></p>}
        {error && <p className="cp-capture-error" role="alert">{error}<button type="button" aria-label="Dismiss error" onClick={() => setError(null)}><CloseIcon /></button></p>}

        {loading ? (
          <div className="cp-capture-empty" aria-busy="true"><span className="cp-capture-empty__mark"><InboxIcon /></span><h2>Opening your local Inbox…</h2></div>
        ) : visibleItems.length === 0 ? (
          <div className="cp-capture-empty"><span className="cp-capture-empty__mark"><PlusIcon /></span><p className="cp-overline">Ready when context appears</p><h2>{items.length === 0 ? "Capture without interrupting your flow." : "No captures match this search."}</h2><p>{items.length === 0 ? "Take a photo, sketch with Pencil, scan a document, keep a file, or write a note." : "Try a different search."}</p></div>
        ) : (
          <div className="cp-capture-grid">
            {visibleItems.map((item) => {
              const selected = selectedIds.has(item.id);
              return (
                <article className={`cp-capture-card kind-${item.kind}${selected ? " is-selected" : ""}`} key={item.id}>
                  <div className="cp-capture-card__preview"><CapturePreview item={item} /><span className="cp-capture-card__kind">{kindIcon(item.kind)}{kindLabel(item.kind)}</span></div>
                  <div className="cp-capture-card__body">
                    <h2>{item.title}</h2>
                    <p>{formatAge(item.createdAt)}{item.byteLength > 0 ? ` · ${formatReviewBytes(item.byteLength)}` : ""}</p>
                    <span className="cp-capture-reusable">Available in every Session</span>
                  </div>
                  {!selecting && <button type="button" className="cp-capture-card__delete" aria-label={`Delete ${item.title}`} onClick={() => setDeletePendingIds([item.id])}><TrashIcon /></button>}
                  {selecting ? (
                    <button type="button" className="cp-capture-card__select" aria-label={`${selected ? "Deselect" : "Select"} ${item.title}`} aria-pressed={selected} onClick={() => toggleSelection(item.id)}><span>{selected && <CheckIcon />}</span></button>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </section>

      {selecting && selectedIds.size > 0 && (
        <div className={`cp-capture-selection-dock${targetSession ? " has-session" : ""}`} role="toolbar" aria-label="Selected capture actions">
          <span><strong>{selectedIds.size} selected</strong><small>{targetSession ? targetSession.title : "Manage local captures"}</small></span>
          {targetSession && <button type="button" className="cp-capture-primary" disabled={!selectionCanUse || preparing} onClick={() => void useInSession()}>{preparing ? "Adding…" : <><DocumentIcon />Use in session</>}</button>}
          <button type="button" className="cp-capture-delete" aria-label="Delete selected captures" onClick={() => setDeletePendingIds([...selectedIds])}><TrashIcon /><span>Delete</span></button>
          {targetSession && !selectionCanUse && <small className="cp-capture-selection-dock__reason">Non-image files remain in the Inbox because the current Review transport cannot attach them yet.</small>}
        </div>
      )}

      {noteOpen && <QuickNoteSheet onClose={() => setNoteOpen(false)} onSave={async (text) => { const firstLine = text.split(/\r?\n/u).find((line) => line.trim())?.trim().slice(0, 72) ?? "Quick note"; await saveLocalCapture({ kind: "note", title: firstLine, text }, "Quick note saved locally."); setNoteOpen(false); }} />}
      {sketchOpen && <SketchSheet onClose={() => setSketchOpen(false)} onSave={async (scene) => { const { blob } = await exportSceneToBoundedPng(scene, { background: "white", padding: 28, maxWidth: 2_048, maxHeight: 2_048, pixelRatio: 1 }); await saveLocalCapture({ kind: "sketch", title: captureTitle("sketch"), blob, fileName: `sketch-${Date.now()}.png` }, "Sketch saved locally."); setSketchOpen(false); }} />}
      {deletePendingIds && (
        <div className="cp-capture-modal-layer" role="presentation"><section className="cp-capture-sheet cp-capture-delete-sheet" role="alertdialog" aria-modal="true" aria-labelledby="delete-captures-title"><span><TrashIcon /></span><h2 id="delete-captures-title">Delete {deletePendingIds.length} {deletePendingIds.length === 1 ? "capture" : "captures"}?</h2><p>This removes the local originals from this iPad. Captures already copied into a Review stay in that Review.</p><div><button type="button" className="cp-secondary-button" onClick={() => setDeletePendingIds(null)}>Keep captures</button><button type="button" className="cp-capture-delete-confirm" onClick={() => void deletePendingCaptures()}>Delete from iPad</button></div></section></div>
      )}
    </main>
  );
}

export default CaptureInboxPage;
