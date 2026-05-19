import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Generate signals every 15 minutes
crons.interval(
  "generate-signals",
  { minutes: 15 },
  internal.signalEngine.generateSignals
);

// Monitor active ideas every 1 minute for SL/TP hits
crons.interval(
  "monitor-ideas",
  { minutes: 1 },
  internal.signalEngine.monitorIdeas
);

export default crons;
