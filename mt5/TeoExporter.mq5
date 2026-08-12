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
//| It writes to MQL5/Files/teo/. Two optional jobs are off unless    |
//| you switch them on:                                               |
//|                                                                   |
//|   HISTORY — the dashboard can ask for a date range (e.g. NAS100   |
//|   M15 from Jan 2024) by dropping a file in teo/requests/. The EA  |
//|   answers into teo/history/. This is how strategy discovery gets  |
//|   two years of bars without streaming them every minute.          |
//|                                                                   |
//|   TRADING — when InpAllowTrading is true, the EA places orders    |
//|   the dashboard writes into teo/orders/ and reports the result    |
//|   into teo/acks/. It is FALSE by default, and while it is false   |
//|   this EA cannot touch your account at all.                       |
//|                                                                   |
//| It never reads account credentials.                               |
//+------------------------------------------------------------------+
#property copyright "XAU Scalper"
#property version   "1.00"
#property strict

//--- Comma-separated symbols to export. Use the names YOUR broker uses:
//--- gold is XAUUSD at some brokers, GOLD or XAUUSD.r at others.
input string InpSymbols      = "XAUUSD";
//--- Timeframes to export. The dashboard analyses M5 and confirms on M15.
input string InpTimeframes   = "M5,M15";
//--- Bars per timeframe.
//--- 5000 M5 bars is about two and a half weeks, which is not enough to test
//--- anything that depends on the time of day: a London-session claim gets
//--- roughly a dozen independent observations out of it, and a dozen
//--- observations cannot tell a real effect from a run of luck. 60000 M5 bars
//--- is about seven months and gives those claims a sample worth testing.
//--- Raise InpIntervalSecs if rewriting a file this size every minute is heavy;
//--- history that is already in the local database is not lost when it ages out
//--- of the export window.
input int    InpBarCount     = 60000;
//--- Seconds between exports. 60 keeps the dashboard within one bar of live.
input int    InpIntervalSecs = 60;
//--- Subdirectory under MQL5/Files.
input string InpOutputDir    = "teo";
//--- Answer history requests from the dashboard (read-only, safe to leave on).
input bool   InpServeHistory = true;
//--- Bars per history answer. 200k M15 bars is roughly six years.
input int    InpHistoryMax   = 200000;
//--- Place orders the dashboard requests. LEAVE FALSE until you mean it.
input bool   InpAllowTrading = false;
//--- Deviation allowed on a market fill, in points.
input int    InpSlippagePts  = 20;
//--- Magic number stamped on every order this EA places.
input long   InpMagic        = 20240517;

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
//| Minimal JSON field readers.                                       |
//|                                                                   |
//| MQL5 has no JSON parser and the dashboard's request files are     |
//| written by one program with a fixed shape, so scanning for        |
//| "key": is enough. A general parser here would be a few hundred    |
//| lines guarding against documents that never arrive.               |
//+------------------------------------------------------------------+
string JsonRaw(const string json, const string key)
{
   string needle = "\"" + key + "\"";
   int k = StringFind(json, needle);
   if(k < 0) return "";
   int colon = StringFind(json, ":", k + StringLen(needle));
   if(colon < 0) return "";

   int i = colon + 1;
   int n = StringLen(json);
   while(i < n)
   {
      ushort c = StringGetCharacter(json, i);
      if(c != ' ' && c != '\t' && c != '\n' && c != '\r') break;
      i++;
   }
   if(i >= n) return "";

   if(StringGetCharacter(json, i) == '"')
   {
      int end = StringFind(json, "\"", i + 1);
      if(end < 0) return "";
      return StringSubstr(json, i + 1, end - i - 1);
   }

   int end = i;
   while(end < n)
   {
      ushort c = StringGetCharacter(json, end);
      if(c == ',' || c == '}' || c == ']' || c == '\n' || c == '\r') break;
      end++;
   }
   string v = StringSubstr(json, i, end - i);
   StringTrimLeft(v);
   StringTrimRight(v);
   return v;
}

double JsonNumber(const string json, const string key) { return StringToDouble(JsonRaw(json, key)); }
long   JsonLong  (const string json, const string key) { return (long)StringToInteger(JsonRaw(json, key)); }
string JsonString(const string json, const string key) { return JsonRaw(json, key); }

//+------------------------------------------------------------------+
//| Read a whole file as text, or "" if it cannot be read.            |
//+------------------------------------------------------------------+
string ReadTextFile(const string path)
{
   int h = FileOpen(path, FILE_READ | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) return "";
   string content = "";
   while(!FileIsEnding(h)) content += FileReadString(h) + "\n";
   FileClose(h);
   return content;
}

//+------------------------------------------------------------------+
//| Write text to a file. Returns false on failure.                   |
//+------------------------------------------------------------------+
bool WriteTextFile(const string path, const string content)
{
   int h = FileOpen(path, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) return false;
   FileWriteString(h, content);
   FileClose(h);
   return true;
}

//+------------------------------------------------------------------+
//| Progress note for a history request the dashboard can poll.       |
//+------------------------------------------------------------------+
void HistoryStatus(const string id, const double progress, const string message)
{
   WriteTextFile(InpOutputDir + "\\history\\" + id + ".status",
                 StringFormat("{\"progress\": %.2f, \"message\": \"%s\"}", progress, message));
}

//+------------------------------------------------------------------+
//| Answer one history request.                                       |
//|                                                                   |
//| The bars are written to a .part file and then renamed, because    |
//| two years of M15 takes seconds to write and the dashboard polls   |
//| every second. Without the rename it would read a truncated file   |
//| and conclude the pull had failed.                                 |
//+------------------------------------------------------------------+
void ServeHistoryRequest(const string file)
{
   string json = ReadTextFile(InpOutputDir + "\\requests\\" + file);
   if(StringLen(json) == 0) return;

   string id     = JsonString(json, "id");
   string symbol = JsonString(json, "symbol");
   string tfName = JsonString(json, "timeframe");
   datetime from = (datetime)JsonLong(json, "from");
   datetime to   = (datetime)JsonLong(json, "to");
   if(StringLen(id) == 0 || StringLen(symbol) == 0) return;

   string outPath  = InpOutputDir + "\\history\\" + id + ".json";
   string partPath = outPath + ".part";

   HistoryStatus(id, 0.05, "Selecting " + symbol);

   ENUM_TIMEFRAMES tf = TimeframeFromString(tfName);
   if(tf == PERIOD_CURRENT)
   {
      WriteTextFile(outPath, StringFormat("{\"error\": \"unknown timeframe %s\"}", tfName));
      return;
   }
   if(!SymbolSelect(symbol, true))
   {
      WriteTextFile(outPath, StringFormat("{\"error\": \"symbol %s is not available at this broker\"}", symbol));
      return;
   }

   HistoryStatus(id, 0.2, "Asking the broker for history…");

   MqlRates rates[];
   ArraySetAsSeries(rates, false);
   int copied = CopyRates(symbol, tf, from, to, rates);

   // A first call often returns -1 while the terminal downloads the range from
   // the broker in the background. Retrying is the documented way to wait for
   // it; failing immediately would make every first request for an old range
   // look like a broken bridge.
   int attempts = 0;
   while(copied <= 0 && attempts < 20)
   {
      attempts++;
      HistoryStatus(id, 0.2 + 0.03 * attempts,
                    StringFormat("Downloading %s %s from the broker (attempt %d)…", symbol, tfName, attempts));
      Sleep(1500);
      copied = CopyRates(symbol, tf, from, to, rates);
   }

   if(copied <= 0)
   {
      WriteTextFile(outPath, StringFormat(
         "{\"error\": \"no %s %s bars between those dates (error %d). The broker may not keep history that far back.\"}",
         symbol, tfName, GetLastError()));
      FileDelete(InpOutputDir + "\\requests\\" + file);
      return;
   }

   if(copied > InpHistoryMax) copied = InpHistoryMax;

   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   int h = FileOpen(partPath, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE)
   {
      PrintFormat("[Teo] cannot write %s (error %d)", partPath, GetLastError());
      return;
   }

   FileWriteString(h, "{\n");
   FileWriteString(h, StringFormat("  \"id\": \"%s\",\n", id));
   FileWriteString(h, StringFormat("  \"symbol\": \"%s\",\n", symbol));
   FileWriteString(h, StringFormat("  \"timeframe\": \"%s\",\n", tfName));
   FileWriteString(h, StringFormat("  \"digits\": %d,\n", digits));
   FileWriteString(h, StringFormat("  \"gmtOffsetSeconds\": %d,\n", ServerGmtOffsetSeconds()));
   FileWriteString(h, StringFormat("  \"exportedAt\": %d,\n", (int)TimeGMT()));
   FileWriteString(h, "  \"bars\": [\n");

   for(int i = 0; i < copied; i++)
   {
      FileWriteString(h, StringFormat(
         "    [%d,%.*f,%.*f,%.*f,%.*f,%d]%s\n",
         (int)rates[i].time,
         digits, rates[i].open,
         digits, rates[i].high,
         digits, rates[i].low,
         digits, rates[i].close,
         (int)rates[i].tick_volume,
         (i == copied - 1 ? "" : ",")));

      if(copied > 5000 && (i % 5000) == 0)
         HistoryStatus(id, 0.3 + 0.6 * ((double)i / copied),
                       StringFormat("Writing %d of %d bars…", i, copied));
   }

   FileWriteString(h, "  ]\n}\n");
   FileClose(h);

   FileDelete(outPath);
   if(!FileMove(partPath, 0, outPath, FILE_REWRITE))
      PrintFormat("[Teo] could not finalise %s (error %d)", outPath, GetLastError());

   FileDelete(InpOutputDir + "\\requests\\" + file);
   PrintFormat("[Teo] history %s %s → %d bars", symbol, tfName, copied);
}

//+------------------------------------------------------------------+
//| Answer every pending history request.                             |
//+------------------------------------------------------------------+
void ServeHistory()
{
   if(!InpServeHistory) return;

   string file;
   long   search = FileFindFirst(InpOutputDir + "\\requests\\*.json", file);
   if(search == INVALID_HANDLE) return;

   do
   {
      // .tmp files are requests the dashboard is still writing; the finished
      // request appears under its real name a moment later.
      if(StringFind(file, ".tmp") < 0) ServeHistoryRequest(file);
   }
   while(FileFindNext(search, file));

   FileFindClose(search);
}

//+------------------------------------------------------------------+
//| Report one order's outcome back to the dashboard.                 |
//+------------------------------------------------------------------+
void WriteAck(const string id, const bool ok, const long ticket,
              const double price, const string error)
{
   string json = StringFormat(
      "{\n  \"id\": \"%s\",\n  \"ok\": %s,\n  \"ticket\": %d,\n  \"price\": %.5f,\n  \"error\": %s,\n  \"at\": %d\n}\n",
      id, (ok ? "true" : "false"), (int)ticket, price,
      (StringLen(error) == 0 ? "null" : "\"" + error + "\""),
      (int)(TimeGMT()) * 1000);
   WriteTextFile(InpOutputDir + "\\acks\\" + id + ".json", json);
}

//+------------------------------------------------------------------+
//| Place one order the dashboard asked for.                          |
//|                                                                   |
//| The order file is DELETED BEFORE the trade is sent. That ordering |
//| is deliberate: if the terminal dies mid-send, the worst case is   |
//| an order that was placed and not recorded, which the operator     |
//| sees in MT5. The other ordering risks placing the same trade      |
//| again on the next timer, which the operator sees only in the P&L. |
//+------------------------------------------------------------------+
void ExecuteOrderFile(const string file)
{
   string path = InpOutputDir + "\\orders\\" + file;
   string json = ReadTextFile(path);
   if(StringLen(json) == 0) return;

   string id        = JsonString(json, "id");
   string symbol    = JsonString(json, "symbol");
   string direction = JsonString(json, "direction");
   double lots      = JsonNumber(json, "lots");
   double sl        = JsonNumber(json, "stopLoss");
   double tp        = JsonNumber(json, "takeProfit");
   string comment   = JsonString(json, "comment");

   FileDelete(path);
   if(StringLen(id) == 0) return;

   if(!SymbolSelect(symbol, true))
   {
      WriteAck(id, false, 0, 0, "symbol " + symbol + " not available");
      return;
   }

   double minLot  = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double maxLot  = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   double lotStep = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   if(lotStep > 0) lots = MathRound(lots / lotStep) * lotStep;
   if(lots < minLot) lots = minLot;
   if(maxLot > 0 && lots > maxLot) lots = maxLot;

   bool isLong = (direction == "LONG");
   double price = isLong ? SymbolInfoDouble(symbol, SYMBOL_ASK)
                         : SymbolInfoDouble(symbol, SYMBOL_BID);

   MqlTradeRequest req;
   MqlTradeResult  res;
   ZeroMemory(req);
   ZeroMemory(res);

   req.action       = TRADE_ACTION_DEAL;
   req.symbol       = symbol;
   req.volume       = lots;
   req.type         = isLong ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   req.price        = price;
   req.sl           = NormalizeDouble(sl, (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS));
   req.tp           = NormalizeDouble(tp, (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS));
   req.deviation    = InpSlippagePts;
   req.magic        = InpMagic;
   req.comment      = comment;
   req.type_filling = ORDER_FILLING_IOC;

   if(!OrderSend(req, res))
   {
      WriteAck(id, false, 0, 0, StringFormat("OrderSend failed, retcode %d", res.retcode));
      PrintFormat("[Teo] order %s rejected (retcode %d)", id, res.retcode);
      return;
   }

   bool ok = (res.retcode == TRADE_RETCODE_DONE || res.retcode == TRADE_RETCODE_PLACED);
   WriteAck(id, ok, (long)res.order, res.price,
            ok ? "" : StringFormat("retcode %d", res.retcode));
   PrintFormat("[Teo] order %s → ticket %d at %.5f (retcode %d)", id, (int)res.order, res.price, res.retcode);
}

//+------------------------------------------------------------------+
//| Place every order waiting in teo/orders/.                         |
//+------------------------------------------------------------------+
void ExecuteOrders()
{
   if(!InpAllowTrading) return;
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) || !MQLInfoInteger(MQL_TRADE_ALLOWED))
   {
      // Silent by design: this is checked every timer tick, and printing here
      // would fill the log with one line a second for a setting the operator
      // fixes in the toolbar.
      return;
   }

   string file;
   long   search = FileFindFirst(InpOutputDir + "\\orders\\*.json", file);
   if(search == INVALID_HANDLE) return;

   do
   {
      if(StringFind(file, ".tmp") < 0) ExecuteOrderFile(file);
   }
   while(FileFindNext(search, file));

   FileFindClose(search);
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
   // CopyRates is bounded by the terminal's own history depth, which is capped
   // per timeframe in Tools > Options > Charts ("Max bars in chart"). Asking for
   // more than that silently returns fewer, so the count is reported after the
   // first export rather than assumed.
   if(InpIntervalSecs < 5)
   {
      Print("[Teo] InpIntervalSecs below 5 would rewrite the files pointlessly often");
      return INIT_PARAMETERS_INCORRECT;
   }

   PrintFormat("[Teo] exporting %s on %s every %ds to MQL5/Files/%s",
               InpSymbols, InpTimeframes, InpIntervalSecs, InpOutputDir);
   PrintFormat("[Teo] history requests: %s | trading: %s",
               (InpServeHistory ? "on" : "off"),
               (InpAllowTrading ? "ON — this EA will place real orders" : "off"));

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
   ServeHistory();
   ExecuteOrders();
}

//+------------------------------------------------------------------+
//| Orders are also checked on every tick.                            |
//|                                                                   |
//| The export timer runs once a minute, which is fine for bars and   |
//| far too slow for an entry: a scalp signal priced a minute ago is  |
//| a different trade. Ticks arrive continuously while the market is  |
//| open, so this is the closest the file bridge gets to immediate.   |
//+------------------------------------------------------------------+
void OnTick()
{
   ExecuteOrders();
}
