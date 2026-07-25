import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PairingScreen, pairingInvitationFromUrl } from "./PairingScreen";

afterEach(() => {
  cleanup();
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
