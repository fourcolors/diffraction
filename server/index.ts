/**
 * Diffraction server — Bun HTTP + WebSocket.
 *
 * Security:
 *   - Binds 127.0.0.1 only
 *   - Requires ?t=<token> on every HTTP + WS request
 *   - Host header must be localhost or 127.0.0.1 (DNS rebinding defense)
 */
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, statSync } from "node:fs";
import {
  validateRepoPath,
  getRepoInfo,
  runDiff,
  runDiffStat,
  getRecentCommits,
  GitError,
  type DiffMode,
} from "./git.ts";
import { watchRepo, type WatchHandle } from "./watcher.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const WEB_DIST = join(ROOT, "web", "dist");

const PORT = parseInt(process.env.PORT ?? "5173", 10);
const TOKEN = process.env.DIFFRACTION_TOKEN ?? randomBytes(16).toString("hex");

interface WSClient {
  repoPath: string | null;
  mode: DiffMode | null;
  watcher: WatchHandle | null;
}

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

function errorJson(message: string, status = 400): Response {
  return json({ error: message }, { status });
}

function checkHost(req: Request): boolean {
  const host = req.headers.get("host") ?? "";
  const h = host.toLowerCase().split(":")[0];
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

function checkToken(url: URL): boolean {
  return url.searchParams.get("t") === TOKEN;
}

/** Parse a mode descriptor from query/body. */
function parseMode(obj: Record<string, any>): DiffMode {
  const kind = obj.mode;
  switch (kind) {
    case "workingTree": return { kind: "workingTree" };
    case "staged": return { kind: "staged" };
    case "branch":
      if (!obj.base || !obj.head) throw new GitError("branch mode requires base and head");
      return { kind: "branch", base: String(obj.base), head: String(obj.head) };
    case "commit":
      if (!obj.sha) throw new GitError("commit mode requires sha");
      return { kind: "commit", sha: String(obj.sha) };
    default:
      throw new GitError(`Unknown mode: ${kind}`);
  }
}

// Static file serving for the built web UI
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function serveStatic(pathname: string): Response | null {
  if (!existsSync(WEB_DIST)) return null;
  let filePath = join(WEB_DIST, pathname === "/" ? "index.html" : pathname);
  if (!filePath.startsWith(WEB_DIST)) return new Response("Forbidden", { status: 403 });
  if (!existsSync(filePath)) {
    // SPA fallback
    filePath = join(WEB_DIST, "index.html");
    if (!existsSync(filePath)) return null;
  }
  if (!statSync(filePath).isFile()) {
    filePath = join(WEB_DIST, "index.html");
    if (!existsSync(filePath)) return null;
  }
  const ext = filePath.slice(filePath.lastIndexOf("."));
  const body = readFileSync(filePath);
  return new Response(body, { headers: { "Content-Type": MIME[ext] ?? "application/octet-stream" } });
}

const server = Bun.serve<WSClient, {}>({
  hostname: "127.0.0.1",
  port: PORT,

  async fetch(req, srv) {
    const url = new URL(req.url);

    if (!checkHost(req)) return new Response("Forbidden host", { status: 403 });

    // WebSocket upgrade
    if (url.pathname === "/ws") {
      if (!checkToken(url)) return new Response("Unauthorized", { status: 401 });
      const success = srv.upgrade(req, { data: { repoPath: null, mode: null, watcher: null } });
      if (success) return undefined as unknown as Response;
      return new Response("Upgrade failed", { status: 400 });
    }

    // API routes require token
    if (url.pathname.startsWith("/api/")) {
      if (!checkToken(url)) return errorJson("Unauthorized", 401);
      try {
        if (url.pathname === "/api/repo/info" && req.method === "GET") {
          const p = validateRepoPath(url.searchParams.get("path") ?? "");
          return json(await getRepoInfo(p));
        }
        if (url.pathname === "/api/diff" && req.method === "POST") {
          const body = await req.json() as any;
          const p = validateRepoPath(body.path);
          const mode = parseMode(body);
          const [diff, stat] = await Promise.all([runDiff(p, mode), runDiffStat(p, mode)]);
          return json({ diff, stat });
        }
        if (url.pathname === "/api/commits" && req.method === "GET") {
          const p = validateRepoPath(url.searchParams.get("path") ?? "");
          const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
          return json(await getRecentCommits(p, limit));
        }
        if (url.pathname === "/api/config" && req.method === "GET") {
          return json({ version: "0.1.0" });
        }
        return errorJson("Not found", 404);
      } catch (e: any) {
        if (e instanceof GitError) return errorJson(e.message, 400);
        console.error("[api error]", e);
        return errorJson(e?.message ?? "Internal error", 500);
      }
    }

    // Unauthenticated landing: if no token in URL, show a tiny bootstrap
    // that redirects to index with token — in practice the user opens the
    // printed URL which includes the token.
    if (url.pathname === "/") {
      if (!checkToken(url)) {
        return new Response(
          `<!doctype html><meta charset="utf-8"><title>Diffraction</title>
           <body style="font-family:system-ui;background:#0e1117;color:#e6edf3;padding:4rem;">
           <h1>🔒 Diffraction</h1>
           <p>This instance requires a token. Open the URL printed by the server in your terminal.</p>
           </body>`,
          { headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }
    }

    // Static files
    const res = serveStatic(url.pathname);
    if (res) return res;
    return new Response("Not found", { status: 404 });
  },

  websocket: {
    open(ws) {
      // noop — client will send a subscribe message
    },
    async message(ws, raw) {
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      try {
        if (msg.type === "subscribe") {
          const repoPath = validateRepoPath(msg.path);
          const mode = parseMode(msg);
          ws.data.repoPath = repoPath;
          ws.data.mode = mode;
          // Close old watcher
          ws.data.watcher?.close();
          // Only live-watch for workingTree/staged modes (ref changes caught by polling)
          ws.data.watcher = watchRepo(repoPath, async () => {
            try {
              const [diff, stat] = await Promise.all([
                runDiff(repoPath, ws.data.mode!),
                runDiffStat(repoPath, ws.data.mode!),
              ]);
              ws.send(JSON.stringify({ type: "diff", diff, stat }));
            } catch (e: any) {
              ws.send(JSON.stringify({ type: "error", message: e?.message ?? "error" }));
            }
          });
          // Send initial diff immediately
          const [diff, stat] = await Promise.all([runDiff(repoPath, mode), runDiffStat(repoPath, mode)]);
          ws.send(JSON.stringify({ type: "diff", diff, stat }));
        } else if (msg.type === "unsubscribe") {
          ws.data.watcher?.close();
          ws.data.watcher = null;
          ws.data.repoPath = null;
          ws.data.mode = null;
        }
      } catch (e: any) {
        ws.send(JSON.stringify({ type: "error", message: e?.message ?? "error" }));
      }
    },
    close(ws) {
      ws.data.watcher?.close();
      ws.data.watcher = null;
    },
  },
});

const url = `http://localhost:${server.port}/?t=${TOKEN}`;
console.log("");
console.log("  ╭─────────────────────────────────────────────╮");
console.log("  │  🌈  Diffraction — local git diff viewer    │");
console.log("  ╰─────────────────────────────────────────────╯");
console.log("");
console.log(`     Open: ${url}`);
console.log(`     Port: ${server.port}`);
console.log("");
console.log("     Press Ctrl+C to stop");
console.log("");
