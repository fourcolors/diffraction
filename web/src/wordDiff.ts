/**
 * Word-level intra-line diff for paired del/add lines.
 *
 * Pipeline:
 *   1. Walk hunk lines, group contiguous del/add blocks.
 *   2. Within each block, pair del ↔ add lines via line-level LCS on
 *      normalized (whitespace-collapsed) content. Unpaired lines stay whole-line.
 *   3. For each pair: if Jaccard(token-sets) ≥ threshold and both sides <= cap,
 *      emit intra-line token deltas.
 *   4. Renderer walks shiki's per-line HTML, splits spans at token offsets,
 *      wraps the removed/added ranges with .w-del / .w-add.
 */
import { diffWordsWithSpace, type Change } from "diff";
import type { DiffLine, DiffHunk } from "./parseDiff";

// ─── Configuration ─────────────────────────────────────────────────────────
export const ENABLE_WORD_DIFF = true;
const JACCARD_THRESHOLD = 0.3;
const MAX_LINE_LENGTH = 500;

// ─── Types ─────────────────────────────────────────────────────────────────
/** A single run within a line: "same" keeps shiki coloring; "changed" paints w-add/w-del bg. */
export interface LineRun {
  start: number;   // char offset into DiffLine.content
  end: number;     // exclusive
  kind: "same" | "changed";
}

/** Derived from a hunk: for each line index, a list of runs for intra-line paint. */
export type HunkRuns = (LineRun[] | null)[]; // null = render plain

// ─── Tokenization (for set comparison) ─────────────────────────────────────
function tokenize(s: string): string[] {
  return s.match(/[A-Za-z0-9_]+/g) ?? [];
}

function jaccard(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 && tb.size === 0) return 1;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

// ─── Line-level LCS for del↔add pairing ────────────────────────────────────
/** Returns map: delIndex → addIndex (paired), or -1 if unpaired. Same for add side. */
function pairDelAdd(dels: string[], adds: string[]): { del2add: number[]; add2del: number[] } {
  const n = dels.length, m = adds.length;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const ND = dels.map(norm), NA = adds.map(norm);

  // Simple DP LCS on normalized-equality
  const dp: number[][] = Array(n + 1).fill(0).map(() => Array(m + 1).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      dp[i + 1]![j + 1] = ND[i] === NA[j]
        ? dp[i]![j]! + 1
        : Math.max(dp[i]![j + 1]!, dp[i + 1]![j]!);
    }
  }

  const del2add = Array(n).fill(-1);
  const add2del = Array(m).fill(-1);
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (ND[i - 1] === NA[j - 1]) {
      del2add[i - 1] = j - 1;
      add2del[j - 1] = i - 1;
      i--; j--;
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) i--;
    else j--;
  }

  // For unpaired dels and adds, pair positionally if Jaccard passes threshold.
  // This catches the common case of "line was edited in place" which LCS rejects.
  const unpairedDels: number[] = [];
  const unpairedAdds: number[] = [];
  for (let k = 0; k < n; k++) if (del2add[k] === -1) unpairedDels.push(k);
  for (let k = 0; k < m; k++) if (add2del[k] === -1) unpairedAdds.push(k);
  const pairs = Math.min(unpairedDels.length, unpairedAdds.length);
  for (let k = 0; k < pairs; k++) {
    const di = unpairedDels[k]!;
    const ai = unpairedAdds[k]!;
    if (jaccard(dels[di]!, adds[ai]!) >= JACCARD_THRESHOLD) {
      del2add[di] = ai;
      add2del[ai] = di;
    }
  }
  return { del2add, add2del };
}

// ─── Turn two paired lines into per-side runs ──────────────────────────────
function runsForPair(delText: string, addText: string): { del: LineRun[]; add: LineRun[] } | null {
  if (delText.length > MAX_LINE_LENGTH || addText.length > MAX_LINE_LENGTH) return null;
  const changes: Change[] = diffWordsWithSpace(delText, addText);
  const delRuns: LineRun[] = [];
  const addRuns: LineRun[] = [];
  let dOff = 0, aOff = 0;
  for (const c of changes) {
    const len = c.value.length;
    if (c.added) {
      addRuns.push({ start: aOff, end: aOff + len, kind: "changed" });
      aOff += len;
    } else if (c.removed) {
      delRuns.push({ start: dOff, end: dOff + len, kind: "changed" });
      dOff += len;
    } else {
      delRuns.push({ start: dOff, end: dOff + len, kind: "same" });
      addRuns.push({ start: aOff, end: aOff + len, kind: "same" });
      dOff += len;
      aOff += len;
    }
  }
  return { del: delRuns, add: addRuns };
}

// ─── Public: compute per-line runs for a hunk ──────────────────────────────
export function computeHunkRuns(hunk: DiffHunk): HunkRuns {
  const runs: HunkRuns = hunk.lines.map(() => null);
  if (!ENABLE_WORD_DIFF) return runs;

  // Walk lines, find contiguous del-block immediately followed by add-block.
  let i = 0;
  while (i < hunk.lines.length) {
    if (hunk.lines[i]!.kind !== "del") { i++; continue; }
    // Collect del block
    const delStart = i;
    while (i < hunk.lines.length && hunk.lines[i]!.kind === "del") i++;
    const delEnd = i; // exclusive
    // Check for immediate add block
    if (i >= hunk.lines.length || hunk.lines[i]!.kind !== "add") continue;
    const addStart = i;
    while (i < hunk.lines.length && hunk.lines[i]!.kind === "add") i++;
    const addEnd = i;

    const dels = hunk.lines.slice(delStart, delEnd).map((l) => l.content);
    const adds = hunk.lines.slice(addStart, addEnd).map((l) => l.content);
    const { del2add } = pairDelAdd(dels, adds);

    for (let k = 0; k < dels.length; k++) {
      const ai = del2add[k];
      if (ai === -1 || ai === undefined) continue;
      const pair = runsForPair(dels[k]!, adds[ai]!);
      if (!pair) continue;
      runs[delStart + k] = pair.del;
      runs[addStart + ai] = pair.add;
    }
  }
  return runs;
}

// ─── Apply runs to shiki-rendered line HTML ────────────────────────────────
/**
 * Given shiki's inner-HTML for a single line and a run list, return HTML where
 * changed ranges are wrapped in <span class="w-del"> or <span class="w-add">
 * (class determined by the line's kind at the call site).
 *
 * We parse by walking text content and bracketing HTML tags. This preserves
 * nested shiki color spans intact within same-runs, and wraps them for
 * changed-runs.
 */
export function applyRunsToHtml(
  html: string,
  content: string,
  runs: LineRun[],
  wrapperClass: "w-add" | "w-del",
): string {
  if (runs.length === 0) return html;

  // Walk the HTML and compute the text offset at each position.
  // Output: segments of HTML keyed by [textStart, textEnd) text range.
  type Segment = { html: string; textStart: number; textEnd: number };
  const segments: Segment[] = [];
  let textPos = 0;
  let i = 0;
  let buf = "";
  const flushBuf = () => {
    if (buf.length > 0) {
      segments.push({ html: buf, textStart: textPos - textOf(buf).length, textEnd: textPos });
      buf = "";
    }
  };
  const textOf = (h: string): string => {
    return h.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  };

  // We need to split at run boundaries. Walk char-by-char of HTML, tracking text offset.
  // Emit output directly.
  let out = "";
  let ti = 0; // text index into `content`
  const runForTextIdx = (idx: number): LineRun | null => {
    for (const r of runs) if (idx >= r.start && idx < r.end) return r;
    return null;
  };

  // To keep it simple: we process raw HTML char by char, accumulate a "current run kind"
  // and open/close our wrapper span when the run under the cursor switches.
  let currentKind: "same" | "changed" | null = null;
  const openWrap = () => { out += `<span class="${wrapperClass}">`; };
  const closeWrap = () => { out += "</span>"; };

  while (i < html.length) {
    if (html[i] === "<") {
      // copy tag verbatim (does not advance text offset)
      const close = html.indexOf(">", i);
      if (close === -1) { out += html.slice(i); break; }
      out += html.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    // Entity (& ... ;) — counts as 1 text char
    let charLen = 1;
    let htmlChunk = html[i]!;
    if (html[i] === "&") {
      const semi = html.indexOf(";", i);
      if (semi !== -1 && semi - i < 8) {
        htmlChunk = html.slice(i, semi + 1);
      }
    }
    const run = runForTextIdx(ti);
    const nextKind = run?.kind ?? null;
    if (nextKind !== currentKind) {
      if (currentKind === "changed") closeWrap();
      if (nextKind === "changed") openWrap();
      currentKind = nextKind;
    }
    out += htmlChunk;
    i += htmlChunk.length;
    ti += charLen;
  }
  if (currentKind === "changed") closeWrap();
  return out;
}
