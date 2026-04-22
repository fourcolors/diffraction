import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TOKEN = "test-token";

/** Create a tmp git repo with a committed file. Returns absolute repo path. */
export function makeTmpRepo(opts: {
  files: Record<string, string>;
  name?: string;
} = { files: {} }): string {
  const dir = mkdtempSync(join(tmpdir(), `diffraction-e2e-${opts.name ?? "repo"}-`));
  execSync("git init -q -b main", { cwd: dir });
  execSync('git config user.email "test@diffraction.local"', { cwd: dir });
  execSync('git config user.name "Diffraction Test"', { cwd: dir });
  for (const [rel, content] of Object.entries(opts.files)) {
    writeFileSync(join(dir, rel), content);
  }
  execSync("git add -A", { cwd: dir });
  execSync('git commit -q -m "baseline"', { cwd: dir });
  return dir;
}

/** Modify a file in the repo (triggers the watcher). */
export function writeInRepo(repo: string, rel: string, content: string): void {
  writeFileSync(join(repo, rel), content);
}

/** Clean up a tmp repo. */
export function cleanup(repo: string): void {
  try { rmSync(repo, { recursive: true, force: true }); } catch { /* noop */ }
}

/** Build the app URL with token. */
export function appUrl(): string {
  return `/?t=${TOKEN}`;
}
