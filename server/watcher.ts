/**
 * Live sync: watch working tree with chokidar, poll .git/HEAD + refs on interval.
 * Emits a "changed" event (debounced) when the caller should re-run the diff.
 */
import chokidar, { type FSWatcher } from "chokidar";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

export interface WatchHandle {
  close(): void;
}

export function watchRepo(
  repoPath: string,
  onChange: () => void,
  opts: { debounceMs?: number; pollMs?: number } = {}
): WatchHandle {
  const debounceMs = opts.debounceMs ?? 200;
  const pollMs = opts.pollMs ?? 1500;

  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; onChange(); }, debounceMs);
  };

  const watcher: FSWatcher = chokidar.watch(repoPath, {
    ignored: (p: string) => {
      // Ignore everything under .git/ except index/HEAD/refs (which we poll separately anyway)
      if (p.includes("/.git/")) return true;
      if (p.endsWith("/node_modules") || p.includes("/node_modules/")) return true;
      if (p.includes("/.DS_Store")) return true;
      return false;
    },
    ignoreInitial: true,
    persistent: true,
    depth: 20,
  });

  watcher.on("all", fire);
  watcher.on("error", () => {}); // silent — permissions issues on weird dirs

  // Poll .git/HEAD + ref state for branch changes / new commits
  let lastRefState = "";
  const poll = () => {
    try {
      const headPath = join(repoPath, ".git", "HEAD");
      const head = existsSync(headPath) ? readFileSync(headPath, "utf8") : "";
      // Get all ref SHAs in one shot
      const refs = execSync("git for-each-ref --format='%(refname) %(objectname)'", {
        cwd: repoPath,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
      });
      // Also include index mtime (for staged changes)
      let indexMark = "";
      const indexPath = join(repoPath, ".git", "index");
      if (existsSync(indexPath)) {
        const { statSync } = require("node:fs");
        indexMark = String(statSync(indexPath).mtimeMs);
      }
      const state = head + refs + indexMark;
      if (lastRefState && state !== lastRefState) fire();
      lastRefState = state;
    } catch {
      // ignore
    }
  };
  poll(); // seed
  const interval = setInterval(poll, pollMs);

  return {
    close() {
      clearInterval(interval);
      if (timer) clearTimeout(timer);
      watcher.close().catch(() => {});
    },
  };
}
