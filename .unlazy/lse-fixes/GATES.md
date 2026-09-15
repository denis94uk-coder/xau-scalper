# Gates: LSE profitability fixes (apply pass)

OWNS: server/lse-engine.ts, server/api.ts, server/__tests__/lse-engine.test.ts, server/__tests__/api.test.ts, .unlazy/lse-fixes/**

Scope: p=0 adopt block at the shared gate, per-strategy direction toggle with API, GER 30-close scoreboard, vault feed audit.

- [x] G1: p=0/NaN never qualifies; direction helper unit-tested
  CWD: /Users/denisteodorbobocea/Documents/GitHub/Jcode-xau-scalper
  CHECK: bun test server/__tests__/lse-engine.test.ts
  EXPECT: 0 fail
  EVIDENCE: automatic-evidence=v1; definition-sha256=5c503424ddc6511fb5edcd780f926eac099bd1d1dc1363c91a83b4e80536f3eb; exit=0; EXPECT=matched; output-sha256=7fa0f8acc5bbf5b1b59f7c1df477f598c4ef151801b8a99bd7886d2e73b6a609; output-bytes=1869; shell=/bin/sh; cwd=/Users/denisteodorbobocea/Documents/GitHub/Jcode-xau-scalper; path=abf85d8b4b31/26 entries

- [x] G2: PATCH direction flags round-trip tested
  CWD: /Users/denisteodorbobocea/Documents/GitHub/Jcode-xau-scalper
  CHECK: bun test server/__tests__/api.test.ts
  EXPECT: 0 fail
  EVIDENCE: automatic-evidence=v1; definition-sha256=16fe58296ec5afffe30b6438adec4fce1d14ca522cf10f331192f48d259d1f83; exit=0; EXPECT=matched; output-sha256=ed4f448042c453aa73ac00ac69298002593832b67b1c170c66a0ec8fc2b6611c; output-bytes=5652; shell=/bin/sh; cwd=/Users/denisteodorbobocea/Documents/GitHub/Jcode-xau-scalper; path=abf85d8b4b31/26 entries

- [x] G3: GER post-1x scoreboard runs against live DB
  CWD: /Users/denisteodorbobocea/Documents/GitHub/Jcode-xau-scalper
  CHECK: bun .unlazy/lse-fixes/score-ger.mjs
  EXPECT: SCORED_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=847be25bc9cf5c76b3164c66f59fa43beccb0ccbe075281163ae67f06de9e769; exit=0; EXPECT=matched; output-sha256=60f6f9a1724aa6f5ceae078c503ec0ae0c3e8047e5e47ba65995c73244acd01f; output-bytes=172; shell=/bin/sh; cwd=/Users/denisteodorbobocea/Documents/GitHub/Jcode-xau-scalper; path=abf85d8b4b31/26 entries

- [x] G4: Vault feed audit runs against live DB
  CWD: /Users/denisteodorbobocea/Documents/GitHub/Jcode-xau-scalper
  CHECK: bun .unlazy/lse-fixes/audit-feed.mjs
  EXPECT: AUDIT_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=0fc34f0065ee2f30ffd386d21939e8b27505be7ef8c415a6a4fddfcadbebf37a; exit=0; EXPECT=matched; output-sha256=077d77ba512b6a8ac4a606c787cad81f04453eaac2677bbc6d43239de4a8bd60; output-bytes=385; shell=/bin/sh; cwd=/Users/denisteodorbobocea/Documents/GitHub/Jcode-xau-scalper; path=abf85d8b4b31/26 entries

- [x] G5: Suites + typecheck green
  CWD: /Users/denisteodorbobocea/Documents/GitHub/Jcode-xau-scalper
  CHECK: bun test server/__tests__/lse-engine.test.ts server/__tests__/api.test.ts server/__tests__/engine.test.ts && ./node_modules/.bin/tsc --noEmit && echo SUITES_GREEN
  EXPECT: SUITES_GREEN
  EVIDENCE: automatic-evidence=v1; definition-sha256=92f8d3268e27090215e871da6e9d305e388b5524f818f1e1a6d291450618586c; exit=0; EXPECT=matched; output-sha256=38afe0a13423f38f19c7fdddf22bdbb16344b2a816a95d8ff0c6f7157e0cc3db; output-bytes=10438; shell=/bin/sh; cwd=/Users/denisteodorbobocea/Documents/GitHub/Jcode-xau-scalper; path=abf85d8b4b31/26 entries
