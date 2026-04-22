/**
 * Git command layer — secure spawn + mode resolvers.
 *
 * Security:
 *   - Paths validated as absolute and containing .git/
 *   - Git spawned with GIT_CONFIG_NOSYSTEM=1, core.hooksPath=/dev/null,
 *     core.fsmonitor=, protocol.ext.allow=never
 *   - Path is never passed as part of argv — always `cwd`
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve, isAbsolute, join } from "node:path";

export type DiffMode =
  | { kind: "workingTree" }
  | { kind: "staged" }
  | { kind: "branch"; base: string; head: string }
  | { kind: "commit"; sha: string };

export interface RepoInfo {
  path: string;
  currentBranch: string;
  branches: string[];
  head: string; // short sha
}

const HARDENING_ARGS = [
  "-c", "protocol.ext.allow=never",
  "-c", "core.fsmonitor=",
  "-c", "core.hooksPath=/dev/null",
];

export class GitError extends Error {
  constructor(message: string, public code: number | null = null, public stderr: string = "") {
    super(message);
    this.name = "GitError";
  }
}

/**
 * Validate a user-supplied repo path.
 * Returns absolute, validated path. Throws on invalid.
 */
export function validateRepoPath(userPath: string): string {
  if (!userPath || typeof userPath !== "string") {
    throw new GitError("Repo path is required");
  }
  // Expand ~ for convenience
  if (userPath.startsWith("~/")) {
    userPath = join(process.env.HOME ?? "", userPath.slice(2));
  }
  const abs = resolve(userPath);
  if (!isAbsolute(abs)) {
    throw new GitError("Repo path must be absolute");
  }
  if (!existsSync(abs)) {
    throw new GitError(`Path does not exist: ${abs}`);
  }
  const st = statSync(abs);
  if (!st.isDirectory()) {
    throw new GitError(`Not a directory: ${abs}`);
  }
  const gitDir = join(abs, ".git");
  if (!existsSync(gitDir)) {
    throw new GitError(`Not a git repository (no .git/): ${abs}`);
  }
  return abs;
}

/**
 * Run a git command in the given repo with hardening flags.
 * Returns stdout. Throws GitError on nonzero exit.
 */
export function git(repoPath: string, args: string[], opts: { maxBuffer?: number } = {}): Promise<string> {
  const maxBuffer = opts.maxBuffer ?? 50 * 1024 * 1024; // 50 MB
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", [...HARDENING_ARGS, ...args], {
      cwd: repoPath,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutLen = 0;
    let killed = false;

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutLen += chunk.length;
      if (stdoutLen > maxBuffer) {
        killed = true;
        child.kill();
        reject(new GitError(`Output exceeded ${maxBuffer} bytes`));
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

    child.on("error", (err) => reject(new GitError(`git spawn failed: ${err.message}`)));
    child.on("close", (code) => {
      if (killed) return;
      if (code === 0) resolvePromise(stdout);
      else reject(new GitError(`git ${args.join(" ")} failed (${code})`, code, stderr.trim()));
    });
  });
}

/** Get repo metadata: current branch, list of local branches, HEAD sha. */
export async function getRepoInfo(repoPath: string): Promise<RepoInfo> {
  const [branchRaw, branchesRaw, headRaw] = await Promise.all([
    git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "HEAD\n"),
    git(repoPath, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]),
    git(repoPath, ["rev-parse", "--short", "HEAD"]).catch(() => "0000000\n"),
  ]);
  return {
    path: repoPath,
    currentBranch: branchRaw.trim(),
    branches: branchesRaw.split("\n").map((s) => s.trim()).filter(Boolean),
    head: headRaw.trim(),
  };
}

/** Validate a ref name — refuse argv injection. */
function validateRef(ref: string): string {
  if (!ref || typeof ref !== "string") throw new GitError("ref required");
  if (ref.startsWith("-")) throw new GitError(`invalid ref: ${ref}`);
  // git's own check-ref-format is the authoritative check, but we use a simple allowlist
  // of characters typical for branches/SHAs/tags.
  if (!/^[a-zA-Z0-9_./\-]+$/.test(ref)) throw new GitError(`invalid ref: ${ref}`);
  return ref;
}

/** Build git diff args for a mode. Returns [args, description]. */
export function diffArgsForMode(mode: DiffMode): string[] {
  // Common flags: no-color (we parse raw), find-renames
  const common = ["--no-color", "-M"];
  switch (mode.kind) {
    case "workingTree":
      return ["diff", ...common, "HEAD"];
    case "staged":
      return ["diff", ...common, "--cached", "HEAD"];
    case "branch": {
      const base = validateRef(mode.base);
      const head = validateRef(mode.head);
      // Three-dot: merge-base diff — matches GitHub PR view.
      return ["diff", ...common, `${base}...${head}`];
    }
    case "commit": {
      const sha = validateRef(mode.sha);
      // show with patch, no stat header, parent..sha — use `show` to include metadata but we want just the diff
      return ["diff", ...common, `${sha}^!`];
    }
  }
}

/** Run diff and return unified diff text. */
export async function runDiff(repoPath: string, mode: DiffMode): Promise<string> {
  const args = diffArgsForMode(mode);
  return git(repoPath, args);
}

/** Get a summary: list of changed files + insertion/deletion counts. */
export async function runDiffStat(repoPath: string, mode: DiffMode): Promise<{
  files: Array<{ path: string; additions: number; deletions: number; status: string }>;
  totalAdditions: number;
  totalDeletions: number;
}> {
  const args = diffArgsForMode(mode);
  // Replace "diff" with "diff --numstat" to get machine-readable stats
  const numstatArgs = [...args, "--numstat"];
  const nameStatusArgs = [...args, "--name-status"];
  const [numstat, nameStatus] = await Promise.all([
    git(repoPath, numstatArgs),
    git(repoPath, nameStatusArgs),
  ]);

  const statusByPath = new Map<string, string>();
  for (const line of nameStatus.split("\n")) {
    const parts = line.split("\t");
    if (parts.length >= 2) {
      const status = parts[0]!;
      const path = parts[parts.length - 1]!;
      statusByPath.set(path, status);
    }
  }

  const files: Array<{ path: string; additions: number; deletions: number; status: string }> = [];
  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const line of numstat.split("\n")) {
    if (!line.trim()) continue;
    const [addStr, delStr, ...pathParts] = line.split("\t");
    const path = pathParts.join("\t");
    const additions = addStr === "-" ? 0 : parseInt(addStr!, 10) || 0;
    const deletions = delStr === "-" ? 0 : parseInt(delStr!, 10) || 0;
    files.push({
      path,
      additions,
      deletions,
      status: statusByPath.get(path) ?? "M",
    });
    totalAdditions += additions;
    totalDeletions += deletions;
  }
  return { files, totalAdditions, totalDeletions };
}

/** Get recent commits (for the commit-picker dropdown). */
export async function getRecentCommits(repoPath: string, limit = 50): Promise<Array<{ sha: string; short: string; subject: string; author: string; date: string }>> {
  const out = await git(repoPath, [
    "log",
    `-n${Math.max(1, Math.min(500, limit))}`,
    "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%aI",
  ]);
  return out.split("\n").filter(Boolean).map((line) => {
    const [sha, short, subject, author, date] = line.split("\x1f");
    return { sha: sha!, short: short!, subject: subject!, author: author!, date: date! };
  });
}
