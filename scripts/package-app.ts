/**
 * Package the app as a standalone executable, optionally as a macOS .app.
 *
 *   bun run package                    # binary for this machine
 *   bun run package -- --target darwin-arm64 --app
 *
 * `bun build --compile` bundles the Bun runtime, the server and the strategy
 * into one executable — no Node, no node_modules, nothing to install. The built
 * UI ships beside it, because compiled binaries resolve import.meta.dir into a
 * virtual filesystem that contains no assets.
 *
 * With --app the result is a double-clickable Foo.app that starts the server
 * and opens the dashboard in the default browser. It is a real bundle rather
 * than a wrapper around a webview: the UI is already a web app, and using the
 * browser avoids shipping a second rendering engine for no gain.
 *
 * Cross-compiling is supported by Bun, so a Mac build can be produced from
 * Linux — but it cannot be RUN or signed here. See the notes printed at the end.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { cp, writeFile } from "node:fs/promises";
import { join } from "node:path";

const APP_NAME = "XAU Scalper";
const BINARY = "xau-scalper";

/** Bun's --target values, mapped from friendlier names. */
const TARGETS: Record<string, string> = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64",
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
  "windows-x64": "bun-windows-x64",
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : "true";
}

async function main() {
  const targetName = arg("target");
  const makeApp = arg("app") !== undefined;
  const outDir = arg("out") ?? "release";

  if (targetName && !TARGETS[targetName]) {
    console.error(
      `Unknown target "${targetName}". Choose one of: ${Object.keys(TARGETS).join(", ")}`,
    );
    process.exit(1);
  }

  if (!existsSync("dist/index.html")) {
    console.error(
      "dist/ is missing or incomplete — run `bun run build` first.",
    );
    process.exit(1);
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // macOS bundles put the executable at Contents/MacOS, and the server looks
  // for dist/ beside itself — so both land in the same directory either way.
  const root = makeApp
    ? join(outDir, `${APP_NAME}.app`, "Contents", "MacOS")
    : outDir;
  mkdirSync(root, { recursive: true });

  const binaryPath = join(root, BINARY);
  const compileArgs = [
    "build",
    "--compile",
    "server/index.ts",
    "--outfile",
    binaryPath,
  ];
  if (targetName) compileArgs.push("--target", TARGETS[targetName]);

  console.log(`Compiling ${targetName ?? "host"} binary…`);
  const proc = Bun.spawnSync(["bun", ...compileArgs], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) {
    console.error("compile failed");
    process.exit(1);
  }

  console.log("Copying UI assets…");
  await cp("dist", join(root, "dist"), { recursive: true });

  if (makeApp) {
    const contents = join(outDir, `${APP_NAME}.app`, "Contents");

    // A launcher script is the executable the bundle points at: it starts the
    // server, waits for it to answer, then opens the browser. Without the wait
    // the browser races the server and shows a connection error.
    const launcher = join(contents, "MacOS", "launch");
    await writeFile(
      launcher,
      `#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"

# Keep data in the user's Application Support rather than inside the bundle,
# which may be read-only and is replaced wholesale on upgrade.
DATA_DIR="\${HOME}/Library/Application Support/${APP_NAME}"
mkdir -p "\${DATA_DIR}"
export TEO_DB_PATH="\${DATA_DIR}/teo.db"
export TEO_PORT="\${TEO_PORT:-4000}"

"\${HERE}/${BINARY}" >> "\${DATA_DIR}/server.log" 2>&1 &
SERVER_PID=$!
trap 'kill \${SERVER_PID} 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:\${TEO_PORT}/api/health" >/dev/null 2>&1; then
    open "http://127.0.0.1:\${TEO_PORT}"
    break
  fi
  sleep 0.5
done

wait \${SERVER_PID}
`,
      { mode: 0o755 },
    );

    await writeFile(
      join(contents, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>local.xauscalper.app</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <!-- Background app: the UI is a browser tab, so no dock icon or menu bar. -->
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict>
</plist>
`,
    );
  }

  const size = Bun.spawnSync(["du", "-sh", outDir])
    .stdout.toString()
    .split("\t")[0];
  console.log(`\nBuilt ${outDir}/ (${size})`);

  if (makeApp) {
    console.log(`
  open "${outDir}/${APP_NAME}.app"

macOS will refuse to open an unsigned bundle downloaded from elsewhere. Built
locally it runs; to distribute it you need an Apple Developer ID:

  codesign --deep --force --sign "Developer ID Application: YOUR NAME" \\
    "${outDir}/${APP_NAME}.app"
`);
  } else {
    console.log(`
  cd ${outDir} && ./${BINARY}
`);
  }

  if (targetName?.startsWith("darwin") && process.platform !== "darwin") {
    console.log(
      "Cross-compiled for macOS from a non-Mac host: this binary cannot be run\n" +
        "or signed here. Verify it on the target machine before relying on it.\n",
    );
  }
}

main();
