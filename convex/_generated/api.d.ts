/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as ViktorSpacesEmail from "../ViktorSpacesEmail.js";
import type * as auth from "../auth.js";
import type * as constants from "../constants.js";
import type * as crons from "../crons.js";
import type * as http from "../http.js";
import type * as liquiditySweep from "../liquiditySweep.js";
import type * as macroCorrelation from "../macroCorrelation.js";
import type * as macroQueries from "../macroQueries.js";
import type * as manualTrades from "../manualTrades.js";
import type * as newsCalendar from "../newsCalendar.js";
import type * as newsQueries from "../newsQueries.js";
import type * as prices from "../prices.js";
import type * as regime from "../regime.js";
import type * as regimeQueries from "../regimeQueries.js";
import type * as seedTestUser from "../seedTestUser.js";
import type * as signalEngine from "../signalEngine.js";
import type * as signalJournal from "../signalJournal.js";
import type * as sweepQueries from "../sweepQueries.js";
import type * as testAuth from "../testAuth.js";
import type * as trades from "../trades.js";
import type * as tradingIdeas from "../tradingIdeas.js";
import type * as users from "../users.js";
import type * as viktorTools from "../viktorTools.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  ViktorSpacesEmail: typeof ViktorSpacesEmail;
  auth: typeof auth;
  constants: typeof constants;
  crons: typeof crons;
  http: typeof http;
  liquiditySweep: typeof liquiditySweep;
  macroCorrelation: typeof macroCorrelation;
  macroQueries: typeof macroQueries;
  manualTrades: typeof manualTrades;
  newsCalendar: typeof newsCalendar;
  newsQueries: typeof newsQueries;
  prices: typeof prices;
  regime: typeof regime;
  regimeQueries: typeof regimeQueries;
  seedTestUser: typeof seedTestUser;
  signalEngine: typeof signalEngine;
  signalJournal: typeof signalJournal;
  sweepQueries: typeof sweepQueries;
  testAuth: typeof testAuth;
  trades: typeof trades;
  tradingIdeas: typeof tradingIdeas;
  users: typeof users;
  viktorTools: typeof viktorTools;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
