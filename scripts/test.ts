import { type ChildProcess, spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

const PREVIEW_PORT = 4173;
const PREVIEW_URL = `http://localhost:${PREVIEW_PORT}`;
const MAX_WAIT_MS = 30000;
const POLL_INTERVAL_MS = 500;

async function waitForServer(url: string, maxWait: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 304) {
        return true;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

function startPreviewServer(): ChildProcess {
  const server = spawn("bun", ["run", "preview"], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  server.stdout?.on("data", (data: Buffer) => {
    const text = data.toString().trim();
    if (text) console.log(`[preview] ${text}`);
  });

  server.stderr?.on("data", (data: Buffer) => {
    const text = data.toString().trim();
    if (text) console.error(`[preview] ${text}`);
  });

  return server;
}

interface TestResult {
  file: string;
  exitCode: number;
}

function getTestLabel(testFile: string): string {
  const name = testFile.replace(/^scripts\//, "").replace(/\.ts$/, "");
  return name.length > 20 ? `${name.slice(0, 17)}...` : name.padEnd(20);
}

async function runTest(testFile: string): Promise<TestResult> {
  return new Promise(resolve => {
    const testPath = testFile.startsWith("/")
      ? testFile
      : join(projectRoot, testFile);

    const label = getTestLabel(testFile);
    console.log(`🧪 [${label}] Starting`);

    const test = spawn("bun", ["run", "--bun", testPath], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        APP_URL: PREVIEW_URL,
      },
    });

    test.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (line.trim()) {
          console.log(`[${label}] ${line}`);
        }
      }
    });

    test.stderr?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (line.trim()) {
          console.error(`[${label}] ${line}`);
        }
      }
    });

    test.on("close", code => {
      resolve({ file: testFile, exitCode: code ?? 1 });
    });

    test.on("error", err => {
      console.error(`[${label}] Failed to run:`, err);
      resolve({ file: testFile, exitCode: 1 });
    });
  });
}

function runUnitTests(): Promise<number> {
  return new Promise(resolve => {
    console.log(
      "🧪 No e2e file given — running unit tests (bun test convex/lib)\n",
    );
    const proc = spawn("bun", ["test", "convex/lib"], {
      cwd: projectRoot,
      stdio: "inherit",
    });
    proc.on("close", code => resolve(code ?? 1));
    proc.on("error", err => {
      console.error("Failed to run unit tests:", err);
      resolve(1);
    });
  });
}

async function main() {
  const args = process.argv.slice(2);

  // With no e2e test file, fall back to the fast unit-test suite so
  // `bun run test` is always meaningful (and CI-friendly) on its own.
  if (args.length === 0) {
    const code = await runUnitTests();
    process.exit(code);
  }

  console.log("🚀 Starting preview server...");
  const server = startPreviewServer();

  let exitCode = 0;

  try {
    console.log(`⏳ Waiting for server at ${PREVIEW_URL}...`);
    const ready = await waitForServer(PREVIEW_URL, MAX_WAIT_MS);

    if (!ready) {
      console.error("❌ Server failed to start within timeout");
      process.exit(1);
    }

    console.log("✅ Server is ready!\n");

    const results = await Promise.all(args.map(testFile => runTest(testFile)));

    for (const result of results) {
      if (result.exitCode !== 0) {
        exitCode = result.exitCode;
        console.error(`\n❌ Test failed: ${result.file}`);
      } else {
        console.log(`\n✅ Test passed: ${result.file}`);
      }
    }
  } finally {
    console.log("\n🛑 Stopping preview server...");
    server.kill("SIGTERM");
    await new Promise(r => setTimeout(r, 500));
  }

  if (exitCode === 0) {
    console.log("\n✅ All tests passed!");
  } else {
    console.log("\n❌ Some tests failed");
  }

  process.exit(exitCode);
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
