import { describe, test, expect, afterEach } from "bun:test";
import { createTempRepo, type TempRepo } from "./helpers/tempRepo";
import {
  validateRepoPath,
  getRepoInfo,
  runDiff,
  runDiffStat,
  getRecentCommits,
  diffArgsForMode,
  GitError,
} from "../server/git";

const repos: TempRepo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});
function fresh(): TempRepo {
  const r = createTempRepo();
  repos.push(r);
  return r;
}

describe("validateRepoPath", () => {
  test("rejects empty path", () => {
    expect(() => validateRepoPath("")).toThrow(GitError);
  });
  test("rejects non-existent path", () => {
    expect(() => validateRepoPath("/tmp/does-not-exist-diffraction-xyz")).toThrow(/does not exist/);
  });
  test("rejects non-git directory", () => {
    expect(() => validateRepoPath("/tmp")).toThrow(/Not a git repository/);
  });
  test("accepts valid git repo", () => {
    const r = fresh();
    r.addAndCommit("a.txt", "hi\n", "initial");
    expect(validateRepoPath(r.path)).toBe(r.path);
  });
});

describe("diffArgsForMode", () => {
  test("working tree uses HEAD", () => {
    expect(diffArgsForMode({ kind: "workingTree" })).toEqual(["diff", "--no-color", "-M", "HEAD"]);
  });
  test("staged uses --cached", () => {
    expect(diffArgsForMode({ kind: "staged" })).toContain("--cached");
  });
  test("branch uses three-dot merge-base form", () => {
    const args = diffArgsForMode({ kind: "branch", base: "main", head: "feature" });
    expect(args).toContain("main...feature");
  });
  test("branch rejects ref starting with dash (argv injection)", () => {
    expect(() => diffArgsForMode({ kind: "branch", base: "--exec=pwn", head: "main" })).toThrow();
  });
  test("branch rejects ref with shell metachars", () => {
    expect(() => diffArgsForMode({ kind: "branch", base: "main;rm", head: "feat" })).toThrow();
  });
  test("commit uses ^! form", () => {
    const args = diffArgsForMode({ kind: "commit", sha: "abc123" });
    expect(args).toContain("abc123^!");
  });
});

describe("getRepoInfo", () => {
  test("reports branch, branches list, head", async () => {
    const r = fresh();
    r.addAndCommit("README.md", "# hi\n", "initial");
    r.checkout("feature", true);
    r.addAndCommit("feat.txt", "feat\n", "feature commit");
    const info = await getRepoInfo(r.path);
    expect(info.currentBranch).toBe("feature");
    expect(info.branches).toContain("main");
    expect(info.branches).toContain("feature");
    expect(info.head).toMatch(/^[0-9a-f]{7,}$/);
  });
});

describe("Scenario 1: Working tree diff", () => {
  test("shows unstaged modifications", async () => {
    const r = fresh();
    r.addAndCommit("README.md", "original\n", "initial");
    r.writeFile("README.md", "modified\n");
    const diff = await runDiff(r.path, { kind: "workingTree" });
    expect(diff).toContain("-original");
    expect(diff).toContain("+modified");
  });

  test("empty diff when working tree clean", async () => {
    const r = fresh();
    r.addAndCommit("a.txt", "x\n", "initial");
    const diff = await runDiff(r.path, { kind: "workingTree" });
    expect(diff.trim()).toBe("");
  });
});

describe("Scenario 2: Staged diff", () => {
  test("shows only staged, not unstaged", async () => {
    const r = fresh();
    r.addAndCommit("a.txt", "v1\n", "initial");
    // Stage a change
    r.writeFile("a.txt", "v2-staged\n");
    r.run("git add a.txt");
    // Add unstaged on top
    r.writeFile("a.txt", "v3-unstaged\n");

    const staged = await runDiff(r.path, { kind: "staged" });
    expect(staged).toContain("+v2-staged");
    expect(staged).not.toContain("v3-unstaged");
  });
});

describe("Scenario 3: Branch vs branch (merge-base three-dot)", () => {
  test("shows total merge-worth of changes", async () => {
    const r = fresh();
    r.addAndCommit("base.txt", "base\n", "initial on main");
    r.checkout("feature", true);
    r.addAndCommit("feat1.txt", "f1\n", "feature commit 1");
    r.addAndCommit("feat2.txt", "f2\n", "feature commit 2");
    // Also add a commit to main after the feature branched (to test merge-base)
    r.checkout("main");
    r.addAndCommit("main-only.txt", "main-new\n", "main after branch");
    r.checkout("feature");

    const diff = await runDiff(r.path, { kind: "branch", base: "main", head: "feature" });
    // Should include feature's changes
    expect(diff).toContain("feat1.txt");
    expect(diff).toContain("feat2.txt");
    // Should NOT include main's post-branch changes (three-dot = merge-base)
    expect(diff).not.toContain("main-only.txt");
  });

  test("stat shows correct file count", async () => {
    const r = fresh();
    r.addAndCommit("base.txt", "base\n", "initial");
    r.checkout("feature", true);
    r.addAndCommit("x.txt", "x\n", "c1");
    r.addAndCommit("y.txt", "y\n", "c2");
    const stat = await runDiffStat(r.path, { kind: "branch", base: "main", head: "feature" });
    expect(stat.files.length).toBe(2);
    expect(stat.totalAdditions).toBe(2);
  });
});

describe("Scenario 4: Single commit diff", () => {
  test("shows only that commit's changes", async () => {
    const r = fresh();
    r.addAndCommit("a.txt", "one\n", "c1");
    const sha2 = r.addAndCommit("b.txt", "two\n", "c2");
    r.addAndCommit("c.txt", "three\n", "c3");
    const diff = await runDiff(r.path, { kind: "commit", sha: sha2 });
    expect(diff).toContain("b.txt");
    expect(diff).toContain("+two");
    expect(diff).not.toContain("a.txt");
    expect(diff).not.toContain("c.txt");
  });
});

describe("runDiffStat", () => {
  test("parses multiple files", async () => {
    const r = fresh();
    r.addAndCommit("a.txt", "1\n", "initial");
    r.writeFile("a.txt", "1\n2\n3\n");
    r.writeFile("b.txt", "new\n");
    r.run("git add -A");
    const stat = await runDiffStat(r.path, { kind: "staged" });
    expect(stat.files.length).toBe(2);
    expect(stat.totalAdditions).toBeGreaterThan(0);
  });
});

describe("getRecentCommits", () => {
  test("returns commits newest-first", async () => {
    const r = fresh();
    r.addAndCommit("a", "1\n", "first");
    r.addAndCommit("b", "2\n", "second");
    r.addAndCommit("c", "3\n", "third");
    const commits = await getRecentCommits(r.path, 10);
    expect(commits.length).toBe(3);
    expect(commits[0]!.subject).toBe("third");
    expect(commits[2]!.subject).toBe("first");
  });
});
