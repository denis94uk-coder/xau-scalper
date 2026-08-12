/**
 * Execution tests.
 *
 * This is the only module that can place a real trade, so the tests are
 * weighted toward everything that must NOT happen: no order while execution is
 * disarmed, none for an instrument the terminal does not serve, and none that
 * escapes the position cap. Each refusal must also leave a journal row, since
 * an operator's first question about a missing trade is "did it decide not to,
 * or did it fail?".
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppConfig, defaultConfig, newAsset } from "../../core/config";
import { Db, type TradingIdea } from "../db";
import { executeIdea } from "../execution";
import { lastAck, pendingOrders } from "../mt5bridge";

let db: Db;
let dir: string;

beforeEach(() => {
  db = new Db(":memory:");
  dir = mkdtempSync(join(tmpdir(), "teo-exec-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  db.close();
});

/** A config with one MT5 instrument and the bridge armed. */
function armed(overrides: Partial<AppConfig["mt5"]> = {}): AppConfig {
  const base = defaultConfig();
  return {
    ...base,
    assets: [
      ...base.assets,
      newAsset("MT5:XAUUSD", {
        displaySymbol: "XAUUSD",
        dataSourceSymbol: "XAUUSD",
        dataSource: "mt5",
        enabled: true,
      }),
    ],
    mt5: {
      ...base.mt5,
      enabled: true,
      executionEnabled: true,
      directory: dir,
      lotSize: 0.05,
      ...overrides,
    },
  };
}

function idea(overrides: Partial<TradingIdea> = {}): TradingIdea {
  const id = db.createIdea({
    asset: "MT5:XAUUSD",
    direction: "LONG",
    source: "engine",
    entryPrice: 2400,
    stopLoss: 2390,
    tp1: 2410,
    tp2: 2420,
    confidence: 70,
    grade: "A",
    reason: "test",
    timeframe: "5m",
    bias: "BULLISH",
    biasStrength: 70,
    spotPrice: 2400,
  });
  return { ...db.getIdea(id)!, ...overrides };
}

function ordersOnDisk(): Array<Record<string, unknown>> {
  const d = join(dir, "orders");
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter(f => f.endsWith(".json"))
    .map(f => JSON.parse(readFileSync(join(d, f), "utf8")));
}

function journalKinds(): string[] {
  return db.listJournal({ limit: 50 }).map(r => r.event_type);
}

describe("refusals", () => {
  test("writes nothing while execution is disarmed", () => {
    const cfg = armed({ executionEnabled: false });
    const outcome = executeIdea(db, cfg, idea());

    expect(outcome.placed).toBe(false);
    expect(ordersOnDisk()).toHaveLength(0);
  });

  test("writes nothing while the whole bridge is off", () => {
    const outcome = executeIdea(db, armed({ enabled: false }), idea());
    expect(outcome.placed).toBe(false);
    expect(ordersOnDisk()).toHaveLength(0);
  });

  test("refuses an instrument the terminal does not serve", () => {
    // A Binance ticker sent to a broker is either rejected or, worse, matched
    // to something the operator did not intend.
    const cfg = armed();
    const binanceIdea = { ...idea(), asset: cfg.assets[0].id };
    const outcome = executeIdea(db, cfg, binanceIdea);

    expect(outcome.placed).toBe(false);
    expect(outcome.reason).toContain("not a MetaTrader 5 instrument");
    expect(ordersOnDisk()).toHaveLength(0);
  });

  test("refuses an instrument that is not configured at all", () => {
    const outcome = executeIdea(db, armed(), { ...idea(), asset: "GHOST" });
    expect(outcome.placed).toBe(false);
    expect(outcome.reason).toContain("not a configured instrument");
  });

  test("respects the in-flight order cap", () => {
    const cfg = armed({ maxOpenPositions: 1 });
    expect(executeIdea(db, cfg, idea()).placed).toBe(true);

    const second = executeIdea(db, cfg, idea());
    expect(second.placed).toBe(false);
    expect(second.reason).toContain("cap");
    expect(ordersOnDisk()).toHaveLength(1);
  });

  test("every refusal is journalled with its reason", () => {
    executeIdea(db, armed({ executionEnabled: false }), idea());
    // Disarmed is the one refusal that is NOT journalled — it is the resting
    // state of the app, and a row per signal would bury the real events.
    expect(journalKinds()).not.toContain("ORDER_SKIPPED");

    executeIdea(db, armed(), { ...idea(), asset: "GHOST" });
    expect(journalKinds()).toContain("ORDER_SKIPPED");
  });
});

describe("placing an order", () => {
  test("writes one order file with the broker's symbol", () => {
    expect(executeIdea(db, armed(), idea()).placed).toBe(true);

    const orders = ordersOnDisk();
    expect(orders).toHaveLength(1);
    expect(orders[0].symbol).toBe("XAUUSD");
    expect(orders[0].direction).toBe("LONG");
    expect(orders[0].lots).toBe(0.05);
  });

  test("brackets the order with the stop and TP2", () => {
    // TP2 rather than TP1: the broker holds one target, and it must be the one
    // the trade is aiming at. TP1 is a partial the engine handles itself.
    const i = idea();
    executeIdea(db, armed(), i);

    const [order] = ordersOnDisk();
    expect(order.stopLoss).toBe(i.stop_loss);
    expect(order.takeProfit).toBe(i.tp2);
  });

  test("carries the idea id, so a fill can be reconciled", () => {
    const i = idea();
    executeIdea(db, armed(), i);
    const [order] = ordersOnDisk();
    expect(order.ideaId).toBe(i.id);
    expect(String(order.comment)).toContain(String(i.id));
  });

  test("journals the send against the idea", () => {
    const i = idea();
    executeIdea(db, armed(), i);

    const row = db
      .listJournal({ limit: 10 })
      .find(r => r.event_type === "ORDER_SENT");
    expect(row).toBeDefined();
    expect(row?.idea_id).toBe(i.id);
  });

  test("a short is sent as a short", () => {
    executeIdea(db, armed(), { ...idea(), direction: "SHORT" });
    expect(ordersOnDisk()[0].direction).toBe("SHORT");
  });

  test("a disarmed engine writes nothing to disk at all", () => {
    // Stronger than "returns not placed": a refusal that still created the
    // orders directory, or a zero-byte file, could be picked up by an EA
    // watching that path. Nothing may appear.
    const cfg = armed();
    const disarmed = {
      ...cfg,
      mt5: { ...cfg.mt5, executionEnabled: false },
    };

    expect(executeIdea(db, disarmed, idea()).placed).toBe(false);
    expect(existsSync(join(dir, "orders"))).toBe(false);
  });

  test("an acknowledgement written by the terminal is read back", () => {
    // The other half of the protocol: the EA deletes the order it took and
    // writes an ack. Without this the app could never tell a filled order from
    // one the terminal never saw.
    const i = idea();
    executeIdea(db, armed(), i);
    const [order] = ordersOnDisk();

    rmSync(join(dir, "orders", `${order.id}.json`));
    mkdirSync(join(dir, "acks"), { recursive: true });
    writeFileSync(
      join(dir, "acks", `${order.id}.json`),
      JSON.stringify({
        id: order.id,
        ok: true,
        ticket: 12345,
        price: 2400.2,
        at: Date.now(),
      }),
      "utf8",
    );

    expect(pendingOrders(dir)).toHaveLength(0);
    const ack = lastAck(dir);
    expect(ack?.id).toBe(String(order.id));
    expect(ack?.ticket).toBe(12345);
  });

  test("two ideas produce two distinct order files", () => {
    const cfg = armed();
    executeIdea(db, cfg, idea());
    executeIdea(db, cfg, idea());

    const orders = ordersOnDisk();
    expect(orders).toHaveLength(2);
    expect(new Set(orders.map(o => o.id)).size).toBe(2);
  });
});
