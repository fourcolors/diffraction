/**
 * Tests for word-level intra-line diff.
 * Runs under bun test against the web/src/wordDiff.ts module.
 */
import { describe, test, expect } from "bun:test";
import { computeHunkRuns, applyRunsToHtml } from "../web/src/wordDiff";
import type { DiffHunk, DiffLine } from "../web/src/parseDiff";

function mkLine(kind: "add" | "del" | "ctx", content: string): DiffLine {
  return { kind, oldNum: 1, newNum: 1, content };
}
function mkHunk(lines: DiffLine[]): DiffHunk {
  return { header: "@@ -1,1 +1,1 @@", lines };
}

describe("computeHunkRuns", () => {
  test("single del/add pair with small edit gets word-diff runs", () => {
    const hunk = mkHunk([
      mkLine("del", `export function hello() { return "world"; }`),
      mkLine("add", `export function hello() { return "universe"; }`),
    ]);
    const runs = computeHunkRuns(hunk);
    expect(runs).toHaveLength(2);
    expect(runs[0]).not.toBeNull();
    expect(runs[1]).not.toBeNull();
    // The del side must have at least one "changed" run covering "world"
    const delChanged = runs[0]!.filter((r) => r.kind === "changed");
    expect(delChanged.length).toBeGreaterThan(0);
    // "world" must fall inside one of the changed ranges
    const delLine = hunk.lines[0]!.content;
    const worldIdx = delLine.indexOf("world");
    const hit = delChanged.some((r) => worldIdx >= r.start && worldIdx < r.end);
    expect(hit).toBe(true);
  });

  test("unrelated del and add get no pairing (low similarity)", () => {
    const hunk = mkHunk([
      mkLine("del", `const xyz = 123;`),
      mkLine("add", `import { foo } from "./bar";`),
    ]);
    const runs = computeHunkRuns(hunk);
    // Jaccard of {"const","xyz"} vs {"import","foo","from","bar"} = 0 → no pair
    expect(runs[0]).toBeNull();
    expect(runs[1]).toBeNull();
  });

  test("context lines always render plain", () => {
    const hunk = mkHunk([
      mkLine("ctx", "  some context"),
      mkLine("del", "old"),
      mkLine("add", "new"),
    ]);
    const runs = computeHunkRuns(hunk);
    expect(runs[0]).toBeNull(); // context
  });

  test("multiple paired lines in a block", () => {
    const hunk = mkHunk([
      mkLine("del", "const a = 1;"),
      mkLine("del", "const b = 2;"),
      mkLine("add", "const a = 10;"),
      mkLine("add", "const b = 20;"),
    ]);
    const runs = computeHunkRuns(hunk);
    // Both del lines should get pairs (1↔10, 2↔20 via Jaccard positional pairing)
    expect(runs[0]).not.toBeNull();
    expect(runs[1]).not.toBeNull();
    expect(runs[2]).not.toBeNull();
    expect(runs[3]).not.toBeNull();
  });

  test("extremely long line is skipped (perf cap)", () => {
    const long = "x".repeat(1000);
    const hunk = mkHunk([
      mkLine("del", long),
      mkLine("add", long + "y"),
    ]);
    const runs = computeHunkRuns(hunk);
    // MAX_LINE_LENGTH = 500; pair exists but runsForPair returns null → runs stay null
    expect(runs[0]).toBeNull();
    expect(runs[1]).toBeNull();
  });
});

describe("applyRunsToHtml", () => {
  test("wraps changed ranges with the given class", () => {
    const content = "hello world";
    const html = "hello world"; // plain (no shiki)
    const runs = [
      { start: 0, end: 6, kind: "same" as const },
      { start: 6, end: 11, kind: "changed" as const },
    ];
    const out = applyRunsToHtml(html, content, runs, "w-add");
    expect(out).toContain('<span class="w-add">world</span>');
    expect(out.startsWith("hello ")).toBe(true);
  });

  test("preserves nested HTML tags inside same runs", () => {
    const content = "abc def";
    // Simulate shiki output: color span around "abc"
    const html = `<span style="color:#f00">abc</span> def`;
    const runs = [
      { start: 0, end: 3, kind: "same" as const },
      { start: 3, end: 4, kind: "same" as const }, // space
      { start: 4, end: 7, kind: "changed" as const }, // def
    ];
    const out = applyRunsToHtml(html, content, runs, "w-del");
    // The original color span stays intact
    expect(out).toContain('<span style="color:#f00">abc</span>');
    // "def" is wrapped
    expect(out).toContain('<span class="w-del">def</span>');
  });

  test("no runs returns html unchanged", () => {
    const html = "<span>abc</span>";
    const out = applyRunsToHtml(html, "abc", [], "w-add");
    expect(out).toBe(html);
  });
});
