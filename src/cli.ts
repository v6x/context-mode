#!/usr/bin/env node
/**
 * context-mode CLI
 *
 * Usage:
 *   context-mode                              → Start MCP server (stdio)
 *   context-mode doctor                       → Diagnose runtime issues, hooks, FTS5, version
 *   context-mode upgrade                      → Fix hooks, permissions, and settings
 *   context-mode hook <platform> <event>      → Dispatch a hook script (used by platform hook configs)
 *
 * Platform auto-detection: CLI detects which platform is running
 * (Claude Code, Gemini CLI, OpenCode, etc.) and uses the appropriate adapter.
 */

import * as p from "@clack/prompts";
import color from "picocolors";
import { execFileSync, execFile as nodeExecFile } from "node:child_process";
import { readFileSync, writeFileSync, cpSync, accessSync, existsSync, readdirSync, rmSync, closeSync, openSync, chmodSync, mkdirSync, constants } from "node:fs";
import { request as httpsRequest } from "node:https";
import { resolve, dirname, join } from "node:path";
import { tmpdir, devNull, homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  detectRuntimes,
  getRuntimeSummary,
  hasBunRuntime,
  getAvailableLanguages,
} from "./runtime.js";

// ── Adapter imports ──────────────────────────────────────
import { detectPlatform, getAdapter } from "./adapters/detect.js";
import type { HookAdapter } from "./adapters/types.js";

/* -------------------------------------------------------
 * Hook dispatcher — `context-mode hook <platform> <event>`
 * ------------------------------------------------------- */

const HOOK_MAP: Record<string, Record<string, string>> = {
  "claude-code": {
    pretooluse: "hooks/pretooluse.mjs",
    posttooluse: "hooks/posttooluse.mjs",
    precompact: "hooks/precompact.mjs",
    sessionstart: "hooks/sessionstart.mjs",
    userpromptsubmit: "hooks/userpromptsubmit.mjs",
  },
  "gemini-cli": {
    beforetool: "hooks/gemini-cli/beforetool.mjs",
    aftertool: "hooks/gemini-cli/aftertool.mjs",
    precompress: "hooks/gemini-cli/precompress.mjs",
    sessionstart: "hooks/gemini-cli/sessionstart.mjs",
  },
  "vscode-copilot": {
    pretooluse: "hooks/vscode-copilot/pretooluse.mjs",
    posttooluse: "hooks/vscode-copilot/posttooluse.mjs",
    precompact: "hooks/vscode-copilot/precompact.mjs",
    sessionstart: "hooks/vscode-copilot/sessionstart.mjs",
  },
  "cursor": {
    pretooluse: "hooks/cursor/pretooluse.mjs",
    posttooluse: "hooks/cursor/posttooluse.mjs",
    sessionstart: "hooks/cursor/sessionstart.mjs",
    stop: "hooks/cursor/stop.mjs",
    afteragentresponse: "hooks/cursor/afteragentresponse.mjs",
  },
  "codex": {
    pretooluse: "hooks/codex/pretooluse.mjs",
    posttooluse: "hooks/codex/posttooluse.mjs",
    sessionstart: "hooks/codex/sessionstart.mjs",
    userpromptsubmit: "hooks/codex/userpromptsubmit.mjs",
    stop: "hooks/codex/stop.mjs",
  },
  "kiro": {
    pretooluse: "hooks/kiro/pretooluse.mjs",
    posttooluse: "hooks/kiro/posttooluse.mjs",
  },
  "jetbrains-copilot": {
    pretooluse: "hooks/jetbrains-copilot/pretooluse.mjs",
    posttooluse: "hooks/jetbrains-copilot/posttooluse.mjs",
    precompact: "hooks/jetbrains-copilot/precompact.mjs",
    sessionstart: "hooks/jetbrains-copilot/sessionstart.mjs",
  },
  "qwen-code": {
    pretooluse: "hooks/pretooluse.mjs",
    posttooluse: "hooks/posttooluse.mjs",
    precompact: "hooks/precompact.mjs",
    sessionstart: "hooks/sessionstart.mjs",
    userpromptsubmit: "hooks/userpromptsubmit.mjs",
  },
};

async function hookDispatch(platform: string, event: string): Promise<void> {
  // Suppress stderr at OS fd level — native C++ modules (better-sqlite3) write
  // directly to fd 2 during initialization, bypassing Node.js process.stderr.
  // Platforms like Claude Code interpret ANY stderr output as hook failure.
  // Cross-platform: os.devNull → /dev/null (Unix) or \\.\NUL (Windows). See: #68
  try {
    closeSync(2);
    openSync(devNull, "w"); // Acquires fd 2 (lowest available)
  } catch {
    process.stderr.write = (() => true) as typeof process.stderr.write;
  }

  const scriptPath = HOOK_MAP[platform]?.[event];
  if (!scriptPath) {
    process.exit(1);
  }
  const pluginRoot = getPluginRoot();
  await import(pathToFileURL(join(pluginRoot, scriptPath)).href);
}

/* -------------------------------------------------------
 * Entry point
 * ------------------------------------------------------- */

const args = process.argv.slice(2);

if (args[0] === "doctor") {
  doctor().then((code) => process.exit(code));
} else if (args[0] === "upgrade") {
  upgrade();
} else if (args[0] === "hook") {
  hookDispatch(args[1], args[2]);
} else if (args[0] === "insight") {
  insight(args[1] ? Number(args[1]) : 4747);
} else if (args[0] === "statusline") {
  // Status line implementation lives in bin/statusline.mjs to keep it
  // dependency-free and fast. Forward stdin and exit with its result.
  statuslineForward();
} else {
  // Default: start MCP server
  import("./server.js");
}

/* -------------------------------------------------------
 * Shared helpers
 * ------------------------------------------------------- */

/** Normalize Windows backslash paths to forward slashes for Bash (MSYS2) compatibility. */
export function toUnixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Windows-safe npm execution. On Windows:
 * - "npm" → "npm.cmd" (Node won't resolve via PATHEXT in execFile)
 * - shell: true required (Node v20+ CVE-2024-27980 mitigation)
 * See: https://github.com/mksglu/context-mode/issues/344
 */
const isWin = process.platform === "win32";

export function npmExecFile(args: string[], opts: Record<string, unknown> = {}): void {
  execFileSync(isWin ? "npm.cmd" : "npm", args, {
    ...opts,
    ...(isWin ? { shell: true } : {}),
  });
}

export function npmExec(command: string, opts: Record<string, unknown> = {}): void {
  const { execSync: es } = require("node:child_process");
  es(isWin ? command.replace(/^npm /, "npm.cmd ") : command, {
    ...opts,
    ...(isWin ? { shell: true } : {}),
  });
}

/**
 * Open a URL in the user's default browser without invoking a shell.
 *
 * Uses `execFile` with an arg array so the URL cannot be interpreted as
 * shell metacharacters.  Original code used `execSync(`open "${url}"`)`
 * which would shell-interpolate the URL — fragile if the URL ever
 * becomes attacker-controlled (remote, weak port-validation, etc).
 *
 * Best-effort: if the OS opener is missing the function logs a copyable
 * URL hint and returns; it never throws.  `runner` is injectable for
 * tests; default is `child_process.execFile` (callback form, fire-and-
 * forget).
 */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  opts?: Record<string, unknown>,
) => unknown;

export function openInBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  runner: ExecFileFn = nodeExecFile as unknown as ExecFileFn,
): void {
  const opts = { stdio: "ignore" as const };
  const hint = () =>
    console.error(`\nCould not auto-open browser. Open manually: ${url}`);

  try {
    if (platform === "darwin") {
      runner("open", [url], opts);
    } else if (platform === "win32") {
      // `start` is a cmd.exe builtin; first arg after `start` is the
      // window title — pass empty so the URL isn't consumed as a title.
      runner("cmd", ["/c", "start", "", url], opts);
    } else {
      // linux/bsd: try xdg-open, fall back to sensible-browser.
      try {
        runner("xdg-open", [url], opts);
      } catch {
        try {
          runner("sensible-browser", [url], opts);
        } catch {
          hint();
        }
      }
    }
  } catch {
    hint();
  }
}

function defaultPluginRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // build/cli.js or src/cli.ts → go up one level; cli.bundle.mjs at project root → stay here
  if (__dirname.endsWith("/build") || __dirname.endsWith("\\build") ||
      __dirname.endsWith("/src") || __dirname.endsWith("\\src")) {
    return resolve(__dirname, "..");
  }
  return __dirname;
}

// Opencode/Kilocode install plugins from npm into a per-package cache folder.
// Layout (changed silently in late 2024 — see PR #376 / KiloCode#9503):
//   POSIX  : ~/.cache/<platform>/packages/context-mode@latest/node_modules/context-mode
//   Windows: %LOCALAPPDATA%\<platform>\packages\context-mode@latest\node_modules\context-mode
function cachePluginRoot(platform: string): string {
  const subPath = ["packages", "context-mode@latest", "node_modules", "context-mode"];
  if (process.platform === "win32") {
    const localApp = process.env.LOCALAPPDATA;
    if (localApp) return resolve(localApp, platform, ...subPath);
    return resolve(homedir(), "AppData", "Local", platform, ...subPath);
  }
  return resolve(homedir(), ".cache", platform, ...subPath);
}

function getPluginRoot(): string {
  const platform = detectPlatform().platform;
  if (platform === 'opencode' || platform === 'kilo') {
    return cachePluginRoot(platform);
  }
  return defaultPluginRoot();
}

function getLocalVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(getPluginRoot(), "package.json"), "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function fetchLatestVersion(): Promise<string> {
  // Use node:https instead of global fetch to avoid a Windows libuv assertion
  // (UV_HANDLE_CLOSING) caused by undici's connection-pool background threads
  // racing with process.exit() teardown on Node.js v24+.
  return new Promise((resolve) => {
    const req = httpsRequest(
      "https://registry.npmjs.org/context-mode/latest",
      { headers: { Connection: "close" } },
      (res) => {
        let raw = "";
        res.on("data", (chunk: Buffer) => { raw += chunk; });
        res.on("end", () => {
          try {
            const data = JSON.parse(raw) as { version?: string };
            resolve(data.version ?? "unknown");
          } catch {
            resolve("unknown");
          }
        });
      },
    );
    req.on("error", () => resolve("unknown"));
    req.setTimeout(5000, () => { req.destroy(); resolve("unknown"); });
    req.end();
  });
}

/* -------------------------------------------------------
 * Doctor — adapter-aware diagnostics
 * ------------------------------------------------------- */

async function doctor(): Promise<number> {
  if (process.stdout.isTTY) console.clear();

  // Detect platform
  const detection = detectPlatform();
  const adapter = await getAdapter(detection.platform);

  p.intro(color.bgMagenta(color.white(" context-mode doctor ")));
  p.log.info(
    `Platform: ${color.cyan(adapter.name)}` +
      color.dim(` (${detection.confidence} confidence — ${detection.reason})`),
  );

  let criticalFails = 0;

  const s = p.spinner();
  s.start("Running diagnostics");

  let runtimes: ReturnType<typeof detectRuntimes>;
  let available: string[];
  try {
    runtimes = detectRuntimes();
    available = getAvailableLanguages(runtimes);
  } catch {
    s.stop("Diagnostics partial");
    p.log.warn(color.yellow("Could not detect runtimes") + color.dim(" — module may be missing, restart session after upgrade"));
    p.outro(color.yellow("Doctor could not fully run — try again after restarting"));
    return 1;
  }

  s.stop("Diagnostics complete");

  // Runtime check
  p.note(getRuntimeSummary(runtimes), "Runtimes");

  // Speed tier
  if (hasBunRuntime()) {
    p.log.success(
      color.green("Performance: FAST") +
        " — Bun detected for JS/TS execution",
    );
  } else {
    p.log.warn(
      color.yellow("Performance: NORMAL") +
        " — Using Node.js (install Bun for 3-5x speed boost)",
    );
  }

  // Language coverage
  const total = 11;
  const pct = ((available.length / total) * 100).toFixed(0);
  if (available.length < 2) {
    criticalFails++;
    p.log.error(
      color.red(`Language coverage: ${available.length}/${total} (${pct}%)`) +
        " — too few runtimes detected" +
        color.dim(` — ${available.join(", ") || "none"}`),
    );
  } else {
    p.log.info(
      `Language coverage: ${available.length}/${total} (${pct}%)` +
        color.dim(` — ${available.join(", ")}`),
    );
  }

  // Server test
  p.log.step("Testing server initialization...");
  try {
    const { PolyglotExecutor } = await import("./executor.js");
    const executor = new PolyglotExecutor({ runtimes });
    const result = await executor.execute({
      language: "javascript",
      code: 'console.log("ok");',
      timeout: 5000,
    });
    if (result.exitCode === 0 && result.stdout.trim() === "ok") {
      p.log.success(color.green("Server test: PASS"));
    } else {
      criticalFails++;
      const detail = result.stderr?.trim() ? ` (${result.stderr.trim().slice(0, 200)})` : "";
      p.log.error(
        color.red("Server test: FAIL") + ` — exit ${result.exitCode}${detail}`,
      );
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Cannot find module") || message.includes("MODULE_NOT_FOUND")) {
      p.log.warn(color.yellow("Server test: SKIP") + color.dim(" — module not available (restart session after upgrade)"));
    } else {
      criticalFails++;
      p.log.error(color.red("Server test: FAIL") + ` — ${message}`);
    }
  }

  // Hooks — adapter-aware validation
  p.log.step(`Checking ${adapter.name} hooks configuration...`);
  const pluginRoot = getPluginRoot();
  const hookResults = adapter.validateHooks(pluginRoot);

  for (const result of hookResults) {
    if (result.status === "pass") {
      p.log.success(color.green(`${result.check}: PASS`) + ` — ${result.message}`);
    } else {
      p.log.error(
        color.red(`${result.check}: FAIL`) +
          ` — ${result.message}` +
          (result.fix ? color.dim(`\n  Run: ${result.fix}`) : ""),
      );
    }
  }

  // Hook script exists
  p.log.step("Checking hook script...");
  const hookScriptPath = resolve(pluginRoot, "hooks", "pretooluse.mjs");
  try {
    accessSync(hookScriptPath, constants.R_OK);
    p.log.success(color.green("Hook script exists: PASS") + color.dim(` — ${hookScriptPath}`));
  } catch {
    p.log.error(
      color.red("Hook script exists: FAIL") +
        color.dim(` — not found at ${hookScriptPath}`),
    );
  }

  // Plugin registration — adapter-aware
  p.log.step(`Checking ${adapter.name} plugin registration...`);
  const pluginCheck = adapter.checkPluginRegistration();
  if (pluginCheck.status === "pass") {
    p.log.success(color.green("Plugin enabled: PASS") + color.dim(` — ${pluginCheck.message}`));
  } else {
    p.log.warn(
      color.yellow("Plugin enabled: WARN") +
        ` — ${pluginCheck.message}`,
    );
  }

  // FTS5 / SQLite
  p.log.step("Checking FTS5 / SQLite...");
  try {
    const Database = (await import("./db-base.js")).loadDatabase();
    const db = new Database(":memory:");
    db.exec("CREATE VIRTUAL TABLE fts_test USING fts5(content)");
    db.exec("INSERT INTO fts_test(content) VALUES ('hello world')");
    const row = db.prepare("SELECT * FROM fts_test WHERE fts_test MATCH 'hello'").get() as { content: string } | undefined;
    db.close();
    if (row && row.content === "hello world") {
      p.log.success(color.green("FTS5 / SQLite: PASS") + " — native module works");
    } else {
      criticalFails++;
      p.log.error(color.red("FTS5 / SQLite: FAIL") + " — query returned unexpected result");
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Cannot find module") || message.includes("MODULE_NOT_FOUND")) {
      p.log.warn(color.yellow("FTS5 / better-sqlite3: SKIP") + color.dim(" — module not available (restart session after upgrade)"));
    } else {
      criticalFails++;
      // Detect better-sqlite3 native bindings-missing pattern (issue #408).
      // The `bindings` package throws "Could not locate the bindings file"
      // when better_sqlite3.node failed to install — typical on Windows
      // when prebuild-install was not on PATH so install fell through to
      // node-gyp without an MSVC toolchain.
      const isBindingsMissing =
        /Could not locate the bindings file/i.test(message) ||
        /bindings\.node/i.test(message) ||
        /\bbindings\b/i.test(message);
      if (isBindingsMissing && process.platform === "win32") {
        p.log.error(
          color.red("FTS5 / better-sqlite3: FAIL") +
            ` — ${message}` +
            color.dim(
              "\n  Root cause: prebuild-install was likely not on PATH, so install fell through to node-gyp without an MSVC toolchain (Windows)." +
              "\n  Try (primary): npm install better-sqlite3   # re-resolves the dep tree and re-links the prebuild-install bin shim to fetch a prebuilt binary" +
              "\n  Try (fallback): npm rebuild better-sqlite3",
            ),
        );
      } else {
        p.log.error(
          color.red("FTS5 / better-sqlite3: FAIL") +
            ` — ${message}` +
            color.dim("\n  Try: npm rebuild better-sqlite3"),
        );
      }
    }
  }

  // Version check — adapter-aware
  p.log.step("Checking versions...");
  const localVersion = getLocalVersion();
  const latestVersion = await fetchLatestVersion();
  const installedVersion = adapter.getInstalledVersion();

  if (latestVersion === "unknown") {
    p.log.warn(
      color.yellow("npm (MCP): WARN") +
        ` — local v${localVersion}, could not reach npm registry`,
    );
  } else if (localVersion === latestVersion) {
    p.log.success(
      color.green("npm (MCP): PASS") +
        ` — v${localVersion}`,
    );
  } else {
    p.log.warn(
      color.yellow("npm (MCP): WARN") +
        ` — local v${localVersion}, latest v${latestVersion}` +
        color.dim("\n  Run: /context-mode:ctx-upgrade"),
    );
  }

  if (installedVersion === "not installed") {
    p.log.info(
      color.dim(`${adapter.name}: not installed`) +
        " — using standalone MCP mode",
    );
  } else if (latestVersion !== "unknown" && installedVersion === latestVersion) {
    p.log.success(
      color.green(`${adapter.name}: PASS`) +
        ` — v${installedVersion}`,
    );
  } else if (latestVersion !== "unknown") {
    p.log.warn(
      color.yellow(`${adapter.name}: WARN`) +
        ` — v${installedVersion}, latest v${latestVersion}` +
        color.dim("\n  Run: /context-mode:ctx-upgrade"),
    );
  } else {
    p.log.info(
      `${adapter.name}: v${installedVersion}` +
        color.dim(" — could not verify against npm registry"),
    );
  }

  // Summary
  if (criticalFails > 0) {
    p.outro(
      color.red(`Diagnostics failed — ${criticalFails} critical issue(s) found`),
    );
    return 1;
  }

  p.outro(
    available.length >= 4
      ? color.green("Diagnostics complete!")
      : color.yellow("Some checks need attention — see above for details"),
  );
  return 0;
}

/* -------------------------------------------------------
 * Insight — analytics dashboard
 * ------------------------------------------------------- */

async function insight(port: number) {
  try {
  const { execSync, spawn } = await import("node:child_process");
  const { statSync, mkdirSync, cpSync } = await import("node:fs");

  const insightSource = resolve(getPluginRoot(), "insight");
  // Detect platform + adapter for correct session/content paths
  const detection = detectPlatform();
  const adapter = await getAdapter(detection.platform);
  const sessDir = adapter.getSessionDir();
  const contentDir = join(dirname(sessDir), "content");
  const cacheDir = join(dirname(sessDir), "insight-cache");

  if (!existsSync(join(insightSource, "server.mjs"))) {
    console.error("Error: Insight source not found. Try upgrading context-mode.");
    process.exit(1);
  }

  mkdirSync(cacheDir, { recursive: true });

  // Copy source if newer
  const srcMtime = statSync(join(insightSource, "server.mjs")).mtimeMs;
  const cacheMtime = existsSync(join(cacheDir, "server.mjs"))
    ? statSync(join(cacheDir, "server.mjs")).mtimeMs : 0;
  if (srcMtime > cacheMtime) {
    console.log("Copying Insight source...");
    cpSync(insightSource, cacheDir, { recursive: true, force: true });
  }

  // Install deps
  if (!existsSync(join(cacheDir, "node_modules"))) {
    console.log("Installing dependencies (first run)...");
    try {
      npmExec("npm install --production=false", { cwd: cacheDir, stdio: "inherit", timeout: 300000 });
    } catch {
      // Clean up partial install so next run retries fresh
      try { rmSync(join(cacheDir, "node_modules"), { recursive: true, force: true }); } catch {}
      throw new Error("npm install failed — please retry");
    }
    // Sentinel check: verify install completed (cold cache can timeout leaving partial node_modules)
    if (!existsSync(join(cacheDir, "node_modules", "vite")) || !existsSync(join(cacheDir, "node_modules", "better-sqlite3"))) {
      rmSync(join(cacheDir, "node_modules"), { recursive: true, force: true });
      throw new Error("npm install incomplete — please retry");
    }
  }

  // Build
  console.log("Building dashboard...");
  execSync("npx vite build", { cwd: cacheDir, stdio: "pipe", timeout: 60000 });

  // Start server
  const url = `http://localhost:${port}`;
  console.log(`\n  context-mode Insight\n  ${url}\n`);

  const child = spawn("node", [join(cacheDir, "server.mjs")], {
    cwd: cacheDir,
    env: {
      ...process.env,
      PORT: String(port),
      INSIGHT_SESSION_DIR: sessDir,
      INSIGHT_CONTENT_DIR: contentDir,
    },
    stdio: "inherit",
  });
  child.on("error", () => {}); // prevent unhandled error crash

  // Wait for server to be ready, then verify it started
  await new Promise(r => setTimeout(r, 1500));

  try {
    const { request } = await import("node:http");
    await new Promise<void>((resolve, reject) => {
      const req = request(`http://127.0.0.1:${port}/api/overview`, { timeout: 3000 }, (res) => {
        resolve();
        res.resume();
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
      req.end();
    });
  } catch {
    console.error(`\nError: Port ${port} appears to be in use. Either a previous dashboard is still running, or another service is using this port.`);
    console.error(`\nTo fix:`);
    console.error(`  Kill the existing process: ${process.platform === "win32" ? `netstat -ano | findstr :${port}` : `lsof -ti:${port} | xargs kill`}`);
    console.error(`  Or use a different port:   context-mode insight ${port + 1}`);
    child.kill();
    process.exit(1);
  }

  // Open browser — execFile with arg array, no shell interpolation.
  openInBrowser(url);

  // Keep alive until Ctrl+C
  process.on("SIGINT", () => { child.kill(); process.exit(0); });
  process.on("SIGTERM", () => { child.kill(); process.exit(0); });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nInsight error: ${msg}`);
    process.exit(1);
  }
}

/* -------------------------------------------------------
 * Upgrade — adapter-aware hook configuration
 * ------------------------------------------------------- */

async function upgrade() {
  // v6x fork policy: upstream `upgrade` clones github.com/mksglu/context-mode
  // and overwrites locally-built bundles, bypassing the v6x security audit.
  // See .voyagerx/2026-05-08-security-audit.md §7.
  if (process.stdout.isTTY) console.clear();
  p.intro(color.bgRed(color.white(" context-mode upgrade — DISABLED in v6x fork ")));
  p.log.error(
    "Automatic upgrade is disabled in this fork.\n" +
    color.dim("  upstream `upgrade` clones github.com/mksglu/context-mode and overwrites\n") +
    color.dim("  locally-built bundles, bypassing the v6x security audit.\n"),
  );
  p.log.info(
    "Manual update flow (run on a controlled machine):\n" +
    color.cyan("  1.") + " cd <fork checkout>\n" +
    color.cyan("  2.") + " git fetch upstream && git log <last-tag>..upstream/main --stat   " + color.dim("# review") + "\n" +
    color.cyan("  3.") + " git merge upstream/main                                          " + color.dim("# after audit") + "\n" +
    color.cyan("  4.") + " bun install --frozen-lockfile && npm run build\n" +
    color.cyan("  5.") + " git tag vX.Y.Z-v6x.N && git push origin vX.Y.Z-v6x.N\n" +
    color.cyan("  6.") + " gh release create vX.Y.Z-v6x.N -F notes.md ./*.tar.gz\n",
  );
  p.outro(color.red("Upgrade aborted."));
  process.exit(1);
}

/* -------------------------------------------------------
 * statusline — forward to bin/statusline.mjs
 * ------------------------------------------------------- */

function statuslineForward(): void {
  // Try multiple plugin-root candidates in priority order. After ctx-upgrade,
  // getPluginRoot() can resolve to a cache dir that sessionstart.mjs (#181)
  // already cleaned, leaving bin/statusline.mjs missing. Falling back to the
  // marketplace clone (#418-synced, stable across upgrades) and to the path
  // Claude Code itself loads from (installed_plugins.json) keeps the bar
  // alive instead of silently going blank.
  const candidates: string[] = [
    resolve(getPluginRoot(), "bin", "statusline.mjs"),
    resolve(homedir(), ".claude", "plugins", "marketplaces", "context-mode", "bin", "statusline.mjs"),
  ];

  // installed_plugins.json may list one or more install paths CC actually
  // loads from. Prefer those if they exist.
  try {
    const registryPath = resolve(homedir(), ".claude", "plugins", "installed_plugins.json");
    if (existsSync(registryPath)) {
      const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
      const entries = registry?.plugins?.["context-mode@context-mode"];
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          const installPath = entry?.installPath;
          if (typeof installPath === "string" && installPath) {
            candidates.push(resolve(installPath, "bin", "statusline.mjs"));
          }
        }
      }
    }
  } catch { /* registry malformed — fall through to other candidates */ }

  const scriptPath = candidates.find((c) => existsSync(c));
  if (!scriptPath) {
    // Statusline output is the user-facing status bar; stderr surfaces visibly
    // in some terminals. Exit silently — the bar simply stays empty until the
    // next /ctx-upgrade or restart resolves the path.
    process.exit(0);
  }
  // Re-exec via dynamic import so stdin/stdout are inherited cleanly.
  import(pathToFileURL(scriptPath).href).catch(() => {
    process.exit(0);
  });
}

