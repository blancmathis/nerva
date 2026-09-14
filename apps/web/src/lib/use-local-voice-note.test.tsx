import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLocalVoiceNote } from "./use-local-voice-note";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
function media() {
  const stop = vi.fn();
  return { stop, stream: { getTracks: () => [{ stop }] } as unknown as MediaStream };
}
class Recorder extends EventTarget {
  static instances: Recorder[] = [];
  static constructionFails = false;
  static startFails = false;
  state = "inactive";
  mimeType = "audio/webm";
  emitsStop = true;
  constructor(_stream: MediaStream) {
    super();
    if (Recorder.constructionFails) throw new Error("Unsupported recorder");
    Recorder.instances.push(this);
  }
  start() {
    if (Recorder.startFails) throw new Error("Cannot start");
    this.state = "recording";
  }
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    if (!this.emitsStop) return;
    queueMicrotask(() => {
      const event = new Event("dataavailable");
      Object.defineProperty(event, "data", { value: new Blob(["final audio chunk"]) });
      this.dispatchEvent(event);
      this.dispatchEvent(new Event("stop"));
    });
  }
}
const renderNote = () => renderHook((props: { active: boolean; scope: string }) => useLocalVoiceNote(props), {
  initialProps: { active: true, scope: "thread-one:tab-one" },
});
let originalMedia: PropertyDescriptor | undefined;
let request: ReturnType<typeof deferred<MediaStream>>;
let microphone: ReturnType<typeof media>;
let getUserMedia: ReturnType<typeof vi.fn>;
beforeEach(() => {
  originalMedia = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  request = deferred<MediaStream>();
  microphone = media();
  getUserMedia = vi.fn(() => request.promise);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  Recorder.instances = []; Recorder.constructionFails = false; Recorder.startFails = false;
  vi.stubGlobal("MediaRecorder", Recorder);
});
afterEach(() => {
  cleanup();
  if (originalMedia) Object.defineProperty(navigator, "mediaDevices", originalMedia);
  else Reflect.deleteProperty(navigator, "mediaDevices");
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
});
async function grant(note: ReturnType<typeof renderNote>) {
  act(() => { void note.result.current.start(); });
  await act(async () => { request.resolve(microphone.stream); });
}

describe("local voice-note ownership", () => {
  it("starts only after a user action and deduplicates pending requests", async () => {
    const note = renderNote();
    expect(getUserMedia).not.toHaveBeenCalled();
    act(() => { void note.result.current.start(); void note.result.current.start(); });
    expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: true });
    expect(note.result.current.phase).toBe("requesting");
    await act(async () => { await note.result.current.stop(); request.resolve(microphone.stream); });
    expect(microphone.stop).toHaveBeenCalledOnce();
    expect(Recorder.instances).toHaveLength(0);
    expect(note.result.current.phase).toBe("idle");
  });

  it("releases a late permission grant after unmount", async () => {
    const note = renderNote();
    act(() => { void note.result.current.start(); });
    note.unmount();
    await act(async () => { request.resolve(microphone.stream); });
    expect(microphone.stop).toHaveBeenCalledOnce();
    expect(Recorder.instances).toHaveLength(0);
  });

  it.each(["closed checkpoint", "different task"])("discards capture on %s", async (change) => {
    const note = renderNote();
    await grant(note);
    note.rerender({ active: change !== "closed checkpoint", scope: change === "different task" ? "thread-two:tab-two" : "thread-one:tab-one" });
    await act(async () => {});
    expect(microphone.stop).toHaveBeenCalledOnce();
    expect(note.result.current.phase).toBe("idle");
    expect(note.result.current.blob).toBeNull();
  });

  it("awaits the final audio chunk while releasing the physical microphone immediately", async () => {
    const note = renderNote();
    await grant(note);
    let completion!: Promise<Blob | null>;
    act(() => { completion = note.result.current.stop(); });
    expect(microphone.stop).toHaveBeenCalledOnce();
    let captured: Blob | null = null;
    await act(async () => { captured = await completion; });
    expect(captured).toMatchObject({ type: "audio/webm", size: new Blob(["final audio chunk"]).size });
    expect(note.result.current.blob).toBe(captured);
    expect(note.result.current.phase).toBe("idle");
  });

  it.each(["constructionFails", "startFails"] as const)("releases the stream when the recorder has %s", async (failure) => {
    Recorder[failure] = true;
    const note = renderNote();
    await grant(note);
    expect(microphone.stop).toHaveBeenCalledOnce();
    expect(note.result.current.phase).toBe("idle");
    expect(note.result.current.error).toContain("Type the explanation instead");
  });

  it("handles permission denial without a stuck pending state", async () => {
    const note = renderNote();
    act(() => { void note.result.current.start(); });
    await act(async () => { request.reject(new DOMException("Denied", "NotAllowedError")); });
    expect(note.result.current.phase).toBe("idle");
    expect(note.result.current.error).toContain("Microphone access was not granted");
  });

  it("releases the microphone and reports an asynchronous recorder error", async () => {
    const note = renderNote();
    await grant(note);
    await act(async () => { Recorder.instances[0]!.dispatchEvent(new Event("error")); });
    expect(microphone.stop).toHaveBeenCalledOnce();
    expect(note.result.current.phase).toBe("idle");
    expect(note.result.current.error).toContain("Try again or type");
    expect(note.result.current.blob).toBeNull();
  });

  it("bounds the stop handshake instead of hanging checkpoint Save", async () => {
    vi.useFakeTimers();
    const note = renderNote();
    await grant(note);
    Recorder.instances[0]!.emitsStop = false;
    let completion!: Promise<Blob | null>;
    act(() => { completion = note.result.current.stop(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await expect(completion).resolves.toBeNull();
    expect(note.result.current.phase).toBe("idle");
    expect(note.result.current.error).toContain("Try again or type");
    expect(microphone.stop).toHaveBeenCalledOnce();
  });

  it("keeps the three-minute capture limit", async () => {
    vi.useFakeTimers();
    const note = renderNote();
    await grant(note);
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * 60 * 1_000); });
    expect(microphone.stop).toHaveBeenCalledOnce();
    expect(note.result.current.phase).toBe("idle");
    expect(note.result.current.blob?.size).toBeGreaterThan(0);
  });

  it("stops recording when the app page is hidden", async () => {
    const note = renderNote();
    await grant(note);
    await act(async () => { window.dispatchEvent(new Event("pagehide")); });
    expect(microphone.stop).toHaveBeenCalledOnce();
    expect(note.result.current.phase).toBe("idle");
    expect(note.result.current.blob?.size).toBeGreaterThan(0);
  });

  it("does not let an old permission grant interfere with a newer capture", async () => {
    const note = renderNote();
    act(() => { void note.result.current.start(); note.result.current.cancel(); });
    const nextRequest = deferred<MediaStream>();
    const nextMicrophone = media();
    getUserMedia.mockImplementationOnce(() => nextRequest.promise);
    act(() => { void note.result.current.start(); });
    await act(async () => { nextRequest.resolve(nextMicrophone.stream); request.resolve(microphone.stream); });
    expect(microphone.stop).toHaveBeenCalledOnce();
    expect(nextMicrophone.stop).not.toHaveBeenCalled();
    expect(note.result.current.phase).toBe("recording");
    expect(Recorder.instances).toHaveLength(1);
  });
});
