/**
 * Pages against the REAL API.
 *
 * The sibling page tests stub `fetch`, which proves the pages render but not
 * that they render what the server actually sends. A stub is written from the
 * same understanding as the page, so the two can agree with each other and both
 * be wrong about the payload — a renamed field, a number arriving as a string,
 * a route that quietly 404s.
 *
 * So these mount the pages against `handleApi` over a real SQLite database. No
 * socket is involved, which keeps them fast and free of port collisions, but
 * every byte the page receives is the byte the server produces.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { handleApi } from "../../server/api";
import { ConfigStore } from "../../server/config";
import { Db } from "../../server/db";
import SettingsPage from "../pages/SettingsPage";

let db: Db;
let store: ConfigStore;

/** Radix opens a tab on pointerdown, not on a synthetic click. */
function openTab(name: RegExp) {
  const tab = screen.getByRole("tab", { name });
  fireEvent.pointerDown(tab, { button: 0, pointerType: "mouse" });
  fireEvent.mouseDown(tab, { button: 0 });
  fireEvent.pointerUp(tab);
  fireEvent.mouseUp(tab);
  fireEvent.click(tab);
}

/** Route the page's fetch into the server's own handler. */
function wireRealApi() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input.toString();
    const url = new URL(raw, "http://127.0.0.1:4000");
    const req = new Request(url, init);
    const res = await handleApi(db, req, url, store);
    return (
      res ??
      new Response(JSON.stringify({ error: "no such endpoint" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })
    );
  }) as typeof fetch;
}

beforeEach(() => {
  // A file rather than :memory: because the app's own store opens WAL mode.
  db = new Db(join(mkdtempSync(join(tmpdir(), "ui-int-")), "app.db"));
  store = new ConfigStore(db);
  wireRealApi();
});

afterEach(() => {
  cleanup();
  db.close?.();
});

describe("Settings page against the real API", () => {
  test("renders the server's actual configuration", async () => {
    render(<SettingsPage />);

    // The default monitor interval, read from the server rather than a fixture.
    await waitFor(() => {
      expect(
        screen.getByDisplayValue(String(store.get().engine.monitorSeconds)),
      ).toBeTruthy();
    });

    // Every configured instrument should be offered, named as the server names
    // it. A stub cannot catch the registry and the page disagreeing.
    openTab(/instruments|assets/i);
    for (const asset of store.get().assets.slice(0, 3)) {
      expect(screen.getAllByText(asset.displaySymbol).length).toBeGreaterThan(
        0,
      );
    }
  });

  test("a save round-trips through the server and survives a remount", async () => {
    const { unmount } = render(<SettingsPage />);
    const before = store.get().engine.monitorSeconds;

    const field = await screen.findByDisplayValue(String(before));
    fireEvent.change(field, { target: { value: "137" } });

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    // Persisted, not merely accepted by the form.
    await waitFor(() => {
      expect(store.get().engine.monitorSeconds).toBe(137);
    });

    // And a fresh page shows the stored value, which is what the operator sees
    // after reopening the app.
    unmount();
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByDisplayValue("137")).toBeTruthy();
    });
  });

  test("the server's rejection is displayed per field, and nothing is saved", async () => {
    render(<SettingsPage />);
    const before = store.get().engine.monitorSeconds;

    const field = await screen.findByDisplayValue(String(before));
    fireEvent.change(field, { target: { value: "999999" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    // The real validator's wording, not a fixture's.
    await waitFor(() => {
      expect(
        screen.getAllByText(/must be between 10 and 3600/i).length,
      ).toBeGreaterThanOrEqual(1);
    });

    // Config is replaced wholesale or not at all: a rejected save leaves the
    // stored document untouched.
    expect(store.get().engine.monitorSeconds).toBe(before);
  });

  test("live execution cannot be armed while the bridge is off", async () => {
    render(<SettingsPage />);
    await waitFor(() =>
      screen.getByDisplayValue(String(store.get().engine.monitorSeconds)),
    );

    openTab(/metatrader 5/i);

    const arm = await screen.findByRole("switch", {
      name: /let the app place orders/i,
    });

    // Disabled in the UI, and the server refuses it too — checked here rather
    // than trusting the control, because the control is the weaker guard.
    expect(arm.getAttribute("data-disabled")).not.toBe(null);

    const cfg = store.get();
    const res = await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...cfg,
        mt5: { ...cfg.mt5, enabled: false, executionEnabled: true },
      }),
    });
    expect(res.status).toBe(422);
    expect(store.get().mt5.executionEnabled).toBe(false);
  });
});
