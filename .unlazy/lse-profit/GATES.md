# Gates: LSE profitability pass

OWNS: .unlazy/lse-profit/**, server/lse-engine.ts, server/__tests__/lse-engine.test.ts

Scope: Pause LSE's 0%-win bleeders, bypass unvalidated regime scaling on LSE exits, and record TP-economics + deeper unprofitability analysis.

- [x] G1: LSE bleeders paused, GER single strategy
  CWD: /Users/denisteodorbobocea/Documents/GitHub/Jcode-xau-scalper
  CHECK: bun .unlazy/lse-profit/verify-carpet.mjs
  EXPECT: CARPET_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=c258c38bcb574a32a838ffaaa2e800e59071b291e6a11478d52364cd946e0c56; exit=0; EXPECT=matched; output-sha256=1983bb38a44a2a975efd4c5107e290a487eca2ab341a519e16668ba9adb89814; output-bytes=122; shell=/bin/sh; cwd=/Users/denisteodorbobocea/Documents/GitHub/Jcode-xau-scalper; path=abf85d8b4b31/26 entries

- [x] G2: LSE exits ignore regime multipliers (validated 1x/1x)
  CWD: /Users/denisteodorbobocea/Documents/GitHub/Jcode-xau-scalper
  CHECK: bun .unlazy/lse-profit/verify-regime.mjs
  EXPECT: BYPASS_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=4870e60d830fe29cf9c5f7f0372e21c198792319f0907b4fc1cee89a5f27a1d9; exit=0; EXPECT=matched; output-sha256=ab0f0aa7258414b2ed2b62bf647d63c4ce4a6ddce93c464803ad5c74066787a6; output-bytes=99; shell=/bin/sh; cwd=/Users/denisteodorbobocea/Documents/GitHub/Jcode-xau-scalper; path=abf85d8b4b31/26 entries

- [x] G3: TP-economics scratch analysis measured from live DB
  CWD: /Users/denisteodorbobocea/Documents/GitHub/Jcode-xau-scalper
  CHECK: bun .unlazy/lse-profit/verify-tp.mjs
  EXPECT: TP_ANALYSIS_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=8990c4562744f4e71cbd326f0925fb2131f77c330723850f853a25edfa57625a; exit=0; EXPECT=matched; output-sha256=16e56ebd2fc84342c77021f666889d26cf8763760bb4af2a20ecdb07fde1dd7e; output-bytes=264; shell=/bin/sh; cwd=/Users/denisteodorbobocea/Documents/GitHub/Jcode-xau-scalper; path=abf85d8b4b31/26 entries

- [x] G4: LSE + API suites green after the change
  CWD: /Users/denisteodorbobocea/Documents/GitHub/Jcode-xau-scalper
  CHECK: bun test server/__tests__/lse-engine.test.ts server/__tests__/api.test.ts server/__tests__/engine.test.ts
  EXPECT: 0 fail
  EVIDENCE: automatic-evidence=v1; definition-sha256=8765726dcf498be8b1d29b37b6a79de909695abaccdde91d36d5bf9635fcd8ac; exit=0; EXPECT=matched; output-sha256=4d332c0ad5f64213489dff494b97fc18274be00f63da03fd0ebe0dc5f49ff72f; output-bytes=9988; shell=/bin/sh; cwd=/Users/denisteodorbobocea/Documents/GitHub/Jcode-xau-scalper; path=abf85d8b4b31/26 entries

- [x] G5: Deeper LSE unprofitability analysis recorded (manual)
  EVIDENCE: .unlazy/lse-profit/ANALYSIS.md — week + full-history tables re-measured from data/teo.db; 8 findings (R:R inversion, regime, p=0 overfit, BTC stacking, XAU double-carpet, scratch factory, GER LONGs, costs); state + watch items recorded.
