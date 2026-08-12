/**
 * Page tests.
 *
 * These mount the real pages against a stubbed `fetch`, which is the only part
 * of the stack a browser would supply. Everything else — the forms, the
 * validation display, the adopt button — is the code a user actually operates.
 *
 * The bundle greps these replace could only prove a string was compiled in, not
 * that the page renders it without throwing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { defaultConfig } from "../../core/config";
import ResearchPage from "../pages/ResearchPage";
import SettingsPage from "../pages/SettingsPage";

type Handler = (path: string, init?: RequestInit) => unknown;

/**
 * Switch tabs the way a mouse does.
 *
 * Radix opens a tab on pointerdown, not on a synthetic `.click()`, so calling
 * click alone leaves the panel unmounted and the test looking for content that
 * a real user would be seeing.
 */
function openTab(name: RegExp) {
  const tab = screen.getByRole("tab", { name });
  fireEvent.pointerDown(tab, { button: 0, pointerType: "mouse" });
  fireEvent.mouseDown(tab, { button: 0 });
  fireEvent.pointerUp(tab);
  fireEvent.mouseUp(tab);
  fireEvent.click(tab);
}

let routes: Record<string, Handler>;
let calls: Array<{ path: string; method: string; body?: string }>;

function stubFetch() {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    calls.push({
      path,
      method: init?.method ?? "GET",
      body: init?.body as string | undefined,
    });

    const key = Object.keys(routes).find(k => path.startsWith(k));
    const payload = key ? routes[key](path, init) : null;
    if (payload === null) {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (payload instanceof Response) return payload;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

beforeEach(() => {
  routes = {
    "/api/config": () => defaultConfig(),
    "/api/mt5/status": () => ({
      directory: null,
      connected: false,
      symbols: [],
      execution: { enabled: false, pending: 0, lastAck: null },
    }),
    "/api/research/runs": () => ({ runs: [] }),
    "/api/assets": () => defaultConfig().assets,
  };
  stubFetch();
});

afterEach(cleanup);

describe("Settings page", () => {
  test("renders the live configuration instead of an empty form", async () => {
    render(<SettingsPage />);

    // The engine cadence is loaded from the document, so seeing its real value
    // proves the form is bound to the server's config and not to placeholders.
    await waitFor(() => {
      expect(screen.getByDisplayValue("60")).toBeTruthy();
    });
  });

  test("shows every configured instrument once its tab is opened", async () => {
    render(<SettingsPage />);
    await waitFor(() => screen.getByDisplayValue("60"));

    // Instruments live behind their own tab, and tab panels mount lazily, so a
    // user has to open it. Clicking is what proves the panel renders at all.
    openTab(/instruments/i);

    await waitFor(() => {
      expect(screen.getAllByDisplayValue("PAXGUSDT").length).toBeGreaterThan(0);
    });
  });

  test("cannot arm live execution while the bridge is off", async () => {
    // The most dangerous switch in the app. The server refuses this combination
    // too, but the control must not even be reachable: an operator should never
    // get as far as believing they armed it.
    render(<SettingsPage />);
    await waitFor(() => screen.getByDisplayValue("60"));

    openTab(/metatrader 5/i);

    const arm = await screen.findByRole("switch", {
      name: /let the app place orders/i,
    });
    expect(arm.getAttribute("data-disabled")).not.toBe(null);
    expect(arm.getAttribute("aria-checked")).toBe("false");
  });

  test("surfaces a server rejection instead of failing silently", async () => {
    routes["/api/config"] = (_p, init) => {
      if (init?.method !== "PUT") return defaultConfig();
      return new Response(
        JSON.stringify({
          error: "engine.monitorSeconds: must be between 10 and 3600",
          issues: [
            {
              path: "engine.monitorSeconds",
              message: "must be between 10 and 3600",
            },
          ],
        }),
        { status: 422, headers: { "Content-Type": "application/json" } },
      );
    };

    render(<SettingsPage />);
    const field = await waitFor(() => screen.getByDisplayValue("60"));

    // Save stays disabled until something is edited, which is why the form has
    // to be changed before the rejection path can be reached at all.
    fireEvent.change(field, { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    // Twice on purpose: once in the summary card at the top, and once beside
    // the offending input. The summary says how many problems there are; the
    // inline copy is what lets someone fix the value without hunting for it.
    await waitFor(() => {
      expect(
        screen.getAllByText(/must be between 10 and 3600/).length,
      ).toBeGreaterThanOrEqual(2);
    });
  });
});

describe("Research page", () => {
  test("renders the search form", async () => {
    render(<ResearchPage />);
    await waitFor(() => {
      expect(screen.getByText(/what to search/i)).toBeTruthy();
    });
  });

  test("reports a null result honestly rather than showing a winner", async () => {
    const run = {
      id: "r1",
      assetId: "MT5:NAS100",
      symbol: "NAS100",
      interval: "15m",
      from: 1_700_000_000,
      to: 1_705_000_000,
      iterations: 300,
      status: "done",
      progress: 1,
      message: "done",
      startedAt: 1,
      finishedAt: 2,
      bars: 38_400,
      error: null,
      report: {
        asset: "MT5:NAS100",
        interval: "15m",
        bars: 38_400,
        from: 1_700_000_000,
        to: 1_705_000_000,
        iterations: 300,
        evaluated: 300,
        seed: 1,
        split: { train: 19_200, validation: 9_600, test: 9_600 },
        candidates: [],
        best: null,
        conclusion: "None of 300 configurations survived.",
      },
    };
    routes["/api/research/runs"] = (path: string) =>
      path.includes("/runs/") ? run : { runs: [run] };

    render(<ResearchPage />);

    // A report belongs to a run the user started, so the flow has to be driven:
    // the page does not show yesterday's results on mount.
    fireEvent.click(
      await screen.findByRole("button", { name: /find a strategy/i }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(/none of 300 configurations survived/i),
      ).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: /use this strategy/i })).toBe(
      null,
    );
  });

  test("offers the adopt button only when a strategy survived", async () => {
    const metrics = {
      trades: 120,
      wins: 70,
      losses: 50,
      breakeven: 0,
      winRate: 58.3,
      netPoints: 420,
      grossPoints: 500,
      costPoints: 80,
      expectancy: 3.5,
      profitFactor: 1.6,
      maxDrawdown: 90,
      breakevenWinRate: 52,
    };
    const run = {
      id: "r2",
      assetId: "MT5:NAS100",
      symbol: "NAS100",
      interval: "15m",
      from: 1_700_000_000,
      to: 1_705_000_000,
      iterations: 300,
      status: "done",
      progress: 1,
      message: "done",
      startedAt: 1,
      finishedAt: 2,
      bars: 38_400,
      error: null,
      report: {
        asset: "MT5:NAS100",
        interval: "15m",
        bars: 38_400,
        from: 1_700_000_000,
        to: 1_705_000_000,
        iterations: 300,
        evaluated: 300,
        seed: 1,
        split: { train: 19_200, validation: 9_600, test: 9_600 },
        candidates: [],
        best: {
          config: defaultConfig().assets[0].config,
          train: metrics,
          validation: metrics,
          test: metrics,
          overall: metrics,
          score: 1,
          significance: { pValue: 0.001, significant: true },
          adjustedPValue: 0.01,
          verdict: "qualified",
          summary: "survived all three windows",
        },
        conclusion: "1 of 300 configurations survived.",
      },
    };
    routes["/api/research/runs"] = (path: string) =>
      path.includes("/runs/") ? run : { runs: [run] };

    render(<ResearchPage />);
    fireEvent.click(
      await screen.findByRole("button", { name: /find a strategy/i }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /use this strategy/i }),
      ).toBeTruthy();
    });

    // The untouched test window is the number to believe, so it has to be on
    // screen beside the two that the search already used.
    expect(screen.getAllByText(/test/i).length).toBeGreaterThan(0);
  });
});
