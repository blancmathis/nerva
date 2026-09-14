import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PairingScreen, pairingInvitationFromUrl, pairingMacName } from "./PairingScreen";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("PairingScreen", () => {
  it("connects a legacy invitation with one tap and an automatic device name", async () => {
    window.history.replaceState({}, "", "/pair?nonce=nonce-from-qr");
    const onPair = vi.fn(async () => ({ ok: false as const, message: "Pairing code expired" }));
    render(<PairingScreen onPair={onPair} />);

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(onPair).toHaveBeenCalledOnce());
    expect(onPair).toHaveBeenCalledWith("nonce-from-qr", expect.stringContaining("Nerva"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Pairing invitation expired");
  });

  it("keeps a fresh fragment invitation unconsumed while Safari explains installation", () => {
    window.history.replaceState({}, "", "/pair#pair=private-fragment-invitation");
    const onPair = vi.fn();
    render(<PairingScreen onPair={onPair} />);

    expect(screen.getByRole("heading", { name: "Add Nerva to Home Screen" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
    expect(onPair).not.toHaveBeenCalled();
  });

  it("accepts only an exact-origin invitation from a scanned URL", () => {
    expect(pairingInvitationFromUrl(`${window.location.origin}/pair#pair=secret`)).toEqual({ nonce: "secret", source: "fragment" });
    expect(pairingInvitationFromUrl("https://attacker.example/pair#pair=secret")).toBeNull();
    expect(pairingInvitationFromUrl(`${window.location.origin}/pair#pair=one&extra=two`)).toBeNull();
  });
});


describe("pairing recovery and camera ownership", () => {
  function permissionRequest() {
    let resolve!: (stream: MediaStream) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<MediaStream>((accept, fail) => { resolve = accept; reject = fail; });
    const request = { promise, resolve, reject };
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
    const getUserMedia = vi.fn(() => request.promise);
    const original = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    return { request, stream, stop, getUserMedia, restore: () => {
      if (original) Object.defineProperty(navigator, "mediaDevices", original);
      else Reflect.deleteProperty(navigator, "mediaDevices");
    } };
  }

  it("does not request the camera twice while permission is pending", async () => {
    const camera = permissionRequest();
    try {
      const view = render(<PairingScreen onPair={vi.fn()} />);
      const scan = screen.getByRole("button", { name: "Scan QR" });
      fireEvent.click(scan);
      fireEvent.click(scan);
      expect(camera.getUserMedia).toHaveBeenCalledOnce();
      expect(scan).toBeDisabled();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeVisible();
      view.unmount();
      await act(async () => { camera.request.resolve(camera.stream); });
    } finally { camera.restore(); }
  });

  it("stops a camera permission grant that arrives after leaving pairing", async () => {
    const camera = permissionRequest();
    try {
      const view = render(<PairingScreen onPair={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: "Scan QR" }));
      view.unmount();
      await act(async () => { camera.request.resolve(camera.stream); });
      expect(camera.stop).toHaveBeenCalledOnce();
    } finally { camera.restore(); }
  });

  it("releases a running camera on Cancel", async () => {
    const camera = permissionRequest();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    try {
      render(<PairingScreen onPair={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: "Scan QR" }));
      await act(async () => { camera.request.resolve(camera.stream); });
      expect(screen.getByRole("button", { name: "Scanning…" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(camera.stop).toHaveBeenCalledOnce();
      expect(screen.getByRole("button", { name: "Scan QR" })).toBeEnabled();
    } finally { camera.restore(); }
  });

  it("offers recovery after permission is denied", async () => {
    const camera = permissionRequest();
    try {
      render(<PairingScreen onPair={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: "Scan QR" }));
      await act(async () => { camera.request.reject(new DOMException("Denied", "NotAllowedError")); });
      expect(screen.getByRole("alert")).toHaveTextContent("Use Camera or Photos below");
      expect(screen.getByRole("button", { name: "Scan QR" })).toBeEnabled();
    } finally { camera.restore(); }
  });

  it("lets a user cancel pending permission and discards the late stream", async () => {
    const camera = permissionRequest();
    try {
      render(<PairingScreen onPair={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: "Scan QR" }));
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await act(async () => { camera.request.resolve(camera.stream); });
      expect(camera.stop).toHaveBeenCalledOnce();
      expect(screen.getByRole("button", { name: "Scan QR" })).toBeEnabled();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    } finally { camera.restore(); }
  });
});


describe("pairing machine label", () => {
  it.each(["127.0.0.1", "100.101.102.103", "[::1]", "fd7a:115c:a1e0::1", "localhost", "preview.localhost", ""])(
    "does not invent a machine name from %s", (host) => {
      expect(pairingMacName(host)).toBe("your Mac");
    },
  );
  it("keeps a readable private DNS machine name", () => {
    expect(pairingMacName("mathis-mac.tailnet.ts.net")).toBe("Mathis Mac");
    expect(pairingMacName("STUDIO_MAC.local.")).toBe("Studio Mac");
  });
  it("recovers when pairing fails before returning a result", async () => {
    window.history.replaceState({}, "", "/pair?nonce=nonce-from-qr");
    render(<PairingScreen onPair={vi.fn().mockRejectedValue(new Error("offline"))} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Check the private connection and try again");
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
  });
});
