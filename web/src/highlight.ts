/**
 * Syntax highlighting for diff hunks via Shiki.
 *
 * Strategy:
 *   - One shared highlighter, preloaded with a small language set
 *   - Highlight each hunk's content (no +/- prefixes) in one call
 *   - Cache by {language, content} → array of per-line HTML strings
 *   - Fallback to plaintext (escaped) when highlighter not ready or language unknown
 */
import { createHighlighter, type Highlighter } from "shiki/bundle/web";
import type { DiffHunk } from "./parseDiff";

// Languages we preload. Keep small — bundle cost.
// Languages available in shiki/bundle/web. Extra langs fall back to plaintext.
const LANGS = [
  "typescript", "tsx", "javascript", "jsx",
  "python",
  "markdown", "json", "yaml",
  "css", "html", "shellscript",
] as const;

// Map file extensions → shiki language id
const EXT_MAP: Record<string, string> = {
  ts: "typescript", tsx: "tsx",
  js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  py: "python",
  md: "markdown", mdx: "markdown",
  json: "json", yml: "yaml", yaml: "yaml",
  css: "css", scss: "css", html: "html",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript",
};

export function langFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  if (!ext) return "text";
  return EXT_MAP[ext] ?? "text";
}

let highlighterPromise: Promise<Highlighter> | null = null;
let highlighter: Highlighter | null = null;

export function initHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["github-dark-dimmed"],
      langs: LANGS as unknown as string[],
    }).then((h) => { highlighter = h; return h; });
  }
  return highlighterPromise;
}

export function isReady(): boolean { return highlighter !== null; }

// Per-hunk cache: `${lang}\0${content}` → array of per-line HTML (inner of `.line` span)
const cache = new Map<string, string[]>();

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]!));
}

/**
 * Highlight a hunk and return per-line HTML strings (inner content only).
 * Falls back to escaped plaintext if highlighter isn't ready or lang is unknown.
 */
export function highlightHunk(hunk: DiffHunk, language: string): string[] {
  // Build the "raw" code body: each line's content in parse order.
  // We skip nothing — add/del/ctx all contribute their visual content.
  const lines = hunk.lines.map((l) => l.content);
  const content = lines.join("\n");
  const key = `${language}\0${content}`;
  const cached = cache.get(key);
  if (cached) return cached;

  // Fallback: plaintext (escaped)
  if (!highlighter || !highlighter.getLoadedLanguages().includes(language as any)) {
    const out = lines.map((l) => escapeHtml(l));
    cache.set(key, out);
    return out;
  }

  try {
    const html = highlighter.codeToHtml(content, {
      lang: language,
      theme: "github-dark-dimmed",
    });
    // Shiki wraps each line in <span class="line">…</span> inside <pre><code>.
    // Extract the inner of each <span class="line">…</span> in order.
    const perLine: string[] = [];
    const re = /<span class="line"[^>]*>([\s\S]*?)<\/span>\s*(?:\n|$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      perLine.push(m[1] ?? "");
    }
    // Defensive: if parsing missed lines, fall back to plaintext for safety
    if (perLine.length !== lines.length) {
      const out = lines.map((l) => escapeHtml(l));
      cache.set(key, out);
      return out;
    }
    cache.set(key, perLine);
    return perLine;
  } catch {
    const out = lines.map((l) => escapeHtml(l));
    cache.set(key, out);
    return out;
  }
}
