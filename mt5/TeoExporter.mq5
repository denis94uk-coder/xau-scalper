//+------------------------------------------------------------------+
//| TeoExporter.mq5                                                   |
//|                                                                   |
//| Exports bars and symbol specifications from a running MetaTrader 5|
//| terminal to JSON files the dashboard reads.                       |
//|                                                                   |
//| WHY A FILE BRIDGE                                                 |
//| The official MetaTrader5 Python package ships win_amd64 wheels    |
//| only — there is no macOS or Linux build — so the usual "Python    |
//| talks to the terminal" route does not exist on a Mac. MT5 itself  |
//| runs there under Wine, and its MQL5/Files directory is a real     |
//| directory on the host filesystem. Writing to it is the one path   |
//| that needs no Python, no DLL and no socket permissions.           |
//|                                                                   |
//| WHAT IT IS FOR                                                    |
//| Not just candles. SYMBOL SPECIFICATIONS matter more: the          |
//| dashboard's cost model was using estimated spreads, and an        |
//| estimate is the difference between a strategy that looks viable   |
//| and one that is. This exports YOUR broker's actual spread,        |
//| contract size and tick value so the backtest reflects what you    |
//| would really pay.                                                 |
//|                                                                   |
//| INSTALL                                                           |
//|   1. In MT5: File → Open Data Folder → MQL5 → Experts             |
//|   2. Copy this file there                                         |
//|   3. In MetaEditor press F7 to compile                            |
//|   4. Drag "TeoExporter" onto any chart                            |
//|   5. Allow it in Tools → Options → Expert Advisors                |
//|                                                                   |
//| It writes to MQL5/Files/teo/. It places no orders and reads no    |
//| account credentials.                                              |
//+------------------------------------------------------------------+
#property copyright "XAU Scalper"
#property version   "1.00"
#property strict

//--- Comma-separated symbols to export. Use the names YOUR broker uses:
//--- gold is XAUUSD at some brokers, GOLD or XAUUSD.r at others.
input string InpSymbols      = "XAUUSD";
//--- Timeframes to export. The dashboard analyses M5 and confirms on M15.
input string InpTimeframes   = "M5,M15";
//--- Bars per timeframe. 5000 M5 bars is about three weeks.
input int    InpBarCount     = 5000;
//--- Seconds between exports. 60 keeps the dashboard within one bar of live.
input int    InpIntervalSecs = 60;
//--- Subdirectory under MQL5/Files.
input string InpOutputDir    = "teo";

//+------------------------------------------------------------------+
//| Map a timeframe name to its enum.                                 |
//+------------------------------------------------------------------+
ENUM_TIMEFRAMES TimeframeFromString(const string name)
{
   string s = name;
   StringTrimLeft(s);
   StringTrimRight(s);
   StringToUpper(s);

   if(s == "M1")  return PERIOD_M1;
   if(s == "M3")  return PERIOD_M3;
   if(s == "M5")  return PERIOD_M5;
   if(s == "M15") return PERIOD_M15;
   if(s == "M30") return PERIOD_M30;
   if(s == "H1")  return PERIOD_H1;
   if(s == "H4")  return PERIOD_H4;
   if(s == "D1")  return PERIOD_D1;
   return PERIOD_CURRENT;
}

//+------------------------------------------------------------------+
//| Split a comma-separated list, trimming each entry.                |
//+------------------------------------------------------------------+
int SplitList(const string csv, string &out[])
{
   int count = StringSplit(csv, ',', out);
   for(int i = 0; i < count; i++)
   {
      StringTrimLeft(out[i]);
      StringTrimRight(out[i]);
   }
   return count;
}

//+------------------------------------------------------------------+
//| Seconds the broker's server time runs ahead of UTC.               |
//|                                                                   |
//| Bar timestamps are in SERVER time, which is typically UTC+2 or +3 |
//| and shifts with daylight saving. Exporting the offset lets the    |
//| reader normalise to UTC instead of guessing — a two-hour error    |
//| would silently misalign every bar against other data sources.     |
//+------------------------------------------------------------------+
int ServerGmtOffsetSeconds()
{
   return (int)(TimeCurrent() - TimeGMT());
}

//+------------------------------------------------------------------+
//| Write one symbol/timeframe to JSON.                               |
//+------------------------------------------------------------------+
bool ExportSeries(const string symbol, const string tfName)
{
   ENUM_TIMEFRAMES tf = TimeframeFromString(tfName);
   if(tf == PERIOD_CURRENT)
   {
      PrintFormat("[Teo] unknown timeframe '%s'", tfName);
      return false;
   }

   // Make sure the symbol is selected, or CopyRates returns nothing for
   // instruments that are not in Market Watch.
   if(!SymbolSelect(symbol, true))
   {
      PrintFormat("[Teo] symbol '%s' not available at this broker", symbol);
      return false;
   }

   MqlRates rates[];
   ArraySetAsSeries(rates, false);
   int copied = CopyRates(symbol, tf, 0, InpBarCount, rates);
   if(copied <= 0)
   {
      PrintFormat("[Teo] no bars for %s %s (error %d)", symbol, tfName, GetLastError());
      return false;
   }

   string path = InpOutputDir + "\\" + symbol + "_" + tfName + ".json";
   int handle = FileOpen(path, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(handle == INVALID_HANDLE)
   {
      PrintFormat("[Teo] cannot write %s (error %d)", path, GetLastError());
      return false;
   }

   int    digits       = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   double point        = SymbolInfoDouble(symbol, SYMBOL_POINT);
   long   spreadPoints = SymbolInfoInteger(symbol, SYMBOL_SPREAD);
   double contractSize = SymbolInfoDouble(symbol, SYMBOL_TRADE_CONTRACT_SIZE);
   double tickValue    = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_VALUE);
   double tickSize     = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE);
   double bid          = SymbolInfoDouble(symbol, SYMBOL_BID);
   double ask          = SymbolInfoDouble(symbol, SYMBOL_ASK);

   FileWriteString(handle, "{\n");
   FileWriteString(handle, StringFormat("  \"symbol\": \"%s\",\n", symbol));
   FileWriteString(handle, StringFormat("  \"timeframe\": \"%s\",\n", tfName));
   FileWriteString(handle, StringFormat("  \"digits\": %d,\n", digits));
   FileWriteString(handle, StringFormat("  \"point\": %.10f,\n", point));
   // Spread in POINTS as the terminal reports it. The reader converts to a
   // price and then to basis points, which is what the cost model wants.
   FileWriteString(handle, StringFormat("  \"spreadPoints\": %d,\n", (int)spreadPoints));
   FileWriteString(handle, StringFormat("  \"contractSize\": %.4f,\n", contractSize));
   FileWriteString(handle, StringFormat("  \"tickValue\": %.6f,\n", tickValue));
   FileWriteString(handle, StringFormat("  \"tickSize\": %.10f,\n", tickSize));
   FileWriteString(handle, StringFormat("  \"bid\": %.*f,\n", digits, bid));
   FileWriteString(handle, StringFormat("  \"ask\": %.*f,\n", digits, ask));
   FileWriteString(handle, StringFormat("  \"gmtOffsetSeconds\": %d,\n", ServerGmtOffsetSeconds()));
   FileWriteString(handle, StringFormat("  \"exportedAt\": %d,\n", (int)TimeGMT()));
   // Tick volume, not traded volume: most FX/CFD brokers do not publish real
   // volume, so this counts price changes. Do not treat it as size.
   FileWriteString(handle, "  \"volumeIsTickCount\": true,\n");
   FileWriteString(handle, "  \"bars\": [\n");

   for(int i = 0; i < copied; i++)
   {
      FileWriteString(handle, StringFormat(
         "    [%d,%.*f,%.*f,%.*f,%.*f,%d]%s\n",
         (int)rates[i].time,
         digits, rates[i].open,
         digits, rates[i].high,
         digits, rates[i].low,
         digits, rates[i].close,
         (int)rates[i].tick_volume,
         (i == copied - 1 ? "" : ",")));
   }

   FileWriteString(handle, "  ]\n}\n");
   FileClose(handle);

   PrintFormat("[Teo] %s %s → %d bars, spread %d points", symbol, tfName, copied, (int)spreadPoints);
   return true;
}

//+------------------------------------------------------------------+
//| Export everything once.                                           |
//+------------------------------------------------------------------+
void ExportAll()
{
   string symbols[];
   string timeframes[];
   int symbolCount = SplitList(InpSymbols, symbols);
   int tfCount     = SplitList(InpTimeframes, timeframes);

   for(int s = 0; s < symbolCount; s++)
   {
      if(StringLen(symbols[s]) == 0) continue;
      for(int t = 0; t < tfCount; t++)
      {
         if(StringLen(timeframes[t]) == 0) continue;
         ExportSeries(symbols[s], timeframes[t]);
      }
   }
}

//+------------------------------------------------------------------+
int OnInit()
{
   if(InpBarCount < 100)
   {
      Print("[Teo] InpBarCount below 100 — the strategy needs 60 bars of warm-up");
      return INIT_PARAMETERS_INCORRECT;
   }
   if(InpIntervalSecs < 5)
   {
      Print("[Teo] InpIntervalSecs below 5 would rewrite the files pointlessly often");
      return INIT_PARAMETERS_INCORRECT;
   }

   PrintFormat("[Teo] exporting %s on %s every %ds to MQL5/Files/%s",
               InpSymbols, InpTimeframes, InpIntervalSecs, InpOutputDir);

   // Export immediately so the dashboard has data without waiting a full cycle.
   ExportAll();
   EventSetTimer(InpIntervalSecs);
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   Print("[Teo] exporter stopped");
}

//+------------------------------------------------------------------+
void OnTimer()
{
   ExportAll();
}
