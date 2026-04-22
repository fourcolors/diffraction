/**
 * Integration test harness — spin up real temp git repos.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

export interface TempRepo {
  path: string;
  writeFile(relPath: string, content: string): void;
  run(cmd: string): string;
  commit(message: string): string; // returns short sha
  addAndCommit(relPath: string, content: string, message: string): string;
  checkout(branch: string, create?: boolean): void;
  cleanup(): void;
}

export function createTempRepo(): TempRepo {
  const path = mkdtempSync(join(tmpdir(), "diffraction-test-"));
  const run = (cmd: string) =>
    execSync(cmd, {
      cwd: path,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
        GIT_CONFIG_NOSYSTEM: "1",
        HOME: path, // isolate from user gitconfig
      },
    }).trim();

  // Init with main as default
  run("git init -q -b main");
  run("git config user.email test@example.com");
  run("git config user.name Test");
  run("git config commit.gpgsign false");

  const writeFile = (relPath: string, content: string) => {
    const full = join(path, relPath);
    const dir = full.slice(0, full.lastIndexOf("/"));
    if (dir && dir !== path) mkdirSync(dir, { recursive: true });
    writeFileSync(full, content);
  };

  const commit = (message: string) => {
    run(`git commit -q -m ${JSON.stringify(message)}`);
    return run("git rev-parse --short HEAD");
  };

  const addAndCommit = (relPath: string, content: string, message: string) => {
    writeFile(relPath, content);
    run(`git add ${JSON.stringify(relPath)}`);
    return commit(message);
  };

  const checkout = (branch: string, create = false) => {
    if (create) run(`git checkout -q -b ${JSON.stringify(branch)}`);
    else run(`git checkout -q ${JSON.stringify(branch)}`);
  };

  const cleanup = () => {
    try { rmSync(path, { recursive: true, force: true }); } catch {}
  };

  return { path, writeFile, run, commit, addAndCommit, checkout, cleanup };
}
