import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Generate signals every 5 minutes (scalper timeframe)
crons.interval(
  "generate-signals",
  { minutes: 5 },
  internal.signalEngine.generateSignals,
);

// Monitor active ideas every 1 minute for SL/TP/trailing hits
crons.interval(
  "monitor-ideas",
  { minutes: 1 },
  internal.signalEngine.monitorIdeas,
);

// ─── Intel Engines (every 5 minutes) ───
crons.interval(
  "regime-detection",
  { minutes: 5 },
  internal.regime.detectMarketRegime,
);

crons.interval(
  "macro-correlation",
  { minutes: 5 },
  internal.macroCorrelation.fetchMacroData,
);

crons.interval(
  "news-calendar",
  { minutes: 5 },
  internal.newsCalendar.updateCalendar,
);

crons.interval(
  "liquidity-sweeps",
  { minutes: 5 },
  internal.liquiditySweep.scanLiquiditySweeps,
);

export default crons;
