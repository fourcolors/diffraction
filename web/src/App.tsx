import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseUnifiedDiff, type DiffFile } from "./parseDiff";
import { initHighlighter, highlightHunk, langFromPath } from "./highlight";

// ─── Types mirrored from server/git.ts ─────────────────────────────────────
type DiffMode =
  | { kind: "workingTree" }
  | { kind: "staged" }
  | { kind: "branch"; base: string; head: string }
  | { kind: "commit"; sha: string };

interface RepoInfo {
  path: string;
  currentBranch: string;
  branches: string[];
  head: string;
}
interface DiffStatFile { path: string; additions: number; deletions: number; status: string; }
interface DiffStat { files: DiffStatFile[]; totalAdditions: number; totalDeletions: number; }
interface Commit { sha: string; short: string; subject: string; author: string; date: string; }

// ─── Token bootstrap ───────────────────────────────────────────────────────
const TOKEN = new URLSearchParams(window.location.search).get("t") ?? "";
const qt = (extra: Record<string, string> = {}) => {
  const p = new URLSearchParams({ t: TOKEN, ...extra });
  return p.toString();
};

// ─── localStorage helpers ──────────────────────────────────────────────────
const LS_RECENT = "diffraction:recentRepos";
const LS_LAST = "diffraction:lastRepo";
function loadRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(LS_RECENT) ?? "[]"); } catch { return []; }
}
function pushRecent(path: string): string[] {
  const next = [path, ...loadRecent().filter((p) => p !== path)].slice(0, 10);
  localStorage.setItem(LS_RECENT, JSON.stringify(next));
  return next;
}

// ─── Stable mode key (for effect deps) ─────────────────────────────────────
function modeKey(m: DiffMode): string {
  switch (m.kind) {
    case "workingTree": return "wt";
    case "staged": return "st";
    case "branch": return `br:${m.base}:${m.head}`;
    case "commit": return `co:${m.sha}`;
  }
}

// ─── API ───────────────────────────────────────────────────────────────────
async function apiRepoInfo(path: string): Promise<RepoInfo> {
  const r = await fetch(`/api/repo/info?${qt({ path })}`);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
  return r.json();
}
async function apiCommits(path: string, limit = 50): Promise<Commit[]> {
  const r = await fetch(`/api/commits?${qt({ path, limit: String(limit) })}`);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
  return r.json();
}

// ─── App ───────────────────────────────────────────────────────────────────
export function App() {
  const [repoPathInput, setRepoPathInput] = useState<string>(() => localStorage.getItem(LS_LAST) ?? "");
  const [repoPath, setRepoPath] = useState<string>("");
  const [repoInfo, setRepoInfo] = useState<RepoInfo | null>(null);
  const [mode, setMode] = useState<DiffMode>({ kind: "workingTree" });
  const [commits, setCommits] = useState<Commit[]>([]);
  const [diffText, setDiffText] = useState<string>("");
  const [stat, setStat] = useState<DiffStat | null>(null);
  const [status, setStatus] = useState<"idle" | "connecting" | "live" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>(() => loadRecent());
  const [highlighterReady, setHighlighterReady] = useState<boolean>(false);

  // ── Preload Shiki highlighter (non-blocking, fallback is plaintext) ──────
  useEffect(() => {
    initHighlighter().then(() => setHighlighterReady(true)).catch(() => setHighlighterReady(false));
  }, []);

  // ── Open repo ────────────────────────────────────────────────────────────
  const openRepo = useCallback(async (path: string) => {
    const p = path.trim();
    if (!p) return;
    setError(null);
    setStatus("connecting");
    try {
      const info = await apiRepoInfo(p);
      setRepoPath(info.path);
      setRepoInfo(info);
      localStorage.setItem(LS_LAST, info.path);
      setRecent(pushRecent(info.path));
      // Load commit list (best-effort)
      apiCommits(info.path).then(setCommits).catch(() => setCommits([]));
      // Default mode to workingTree on every fresh open
      setMode({ kind: "workingTree" });
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setStatus("error");
      setRepoInfo(null);
    }
  }, []);

  // ── Auto-open last repo on mount ─────────────────────────────────────────
  useEffect(() => {
    const last = localStorage.getItem(LS_LAST);
    if (last) openRepo(last);
  }, [openRepo]);

  // ── WS lifecycle: re-subscribe on repo or mode change ────────────────────
  const stableMode = useMemo(() => mode, [modeKey(mode)]);
  useEffect(() => {
    if (!repoPath || !repoInfo) return;
    setStatus("connecting");
    const wsUrl = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws?${qt()}`;
    const ws = new WebSocket(wsUrl);
    let cancelled = false;

    ws.onopen = () => {
      if (cancelled || ws.readyState !== WebSocket.OPEN) return;
      const payload: any = { type: "subscribe", path: repoPath, mode: stableMode.kind };
      if (stableMode.kind === "branch") { payload.base = stableMode.base; payload.head = stableMode.head; }
      if (stableMode.kind === "commit") { payload.sha = stableMode.sha; }
      ws.send(JSON.stringify(payload));
    };
    ws.onmessage = (ev) => {
      if (cancelled) return;
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === "diff") {
          setDiffText(msg.diff);
          setStat(msg.stat);
          setError(null);
          setStatus("live");
        } else if (msg.type === "error") {
          setError(msg.message ?? "unknown error");
          setStatus("error");
        }
      } catch { /* ignore */ }
    };
    ws.onerror = () => { if (!cancelled) { setError("WebSocket error"); setStatus("error"); } };
    ws.onclose = () => { if (!cancelled) setStatus((s) => (s === "error" ? s : "idle")); };

    return () => {
      cancelled = true;
      try { ws.close(); } catch { /* noop */ }
    };
  }, [repoPath, repoInfo, stableMode]);

  const parsed: DiffFile[] = useMemo(() => parseUnifiedDiff(diffText), [diffText]);

  return (
    <div className="app">
      <header className="header">
        <div className="logo">Diffraction</div>
        <input
          className="input"
          placeholder="/absolute/path/to/repo"
          value={repoPathInput}
          onChange={(e) => setRepoPathInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") openRepo(repoPathInput); }}
          style={{ flex: 1, minWidth: 280 }}
          data-testid="repo-input"
        />
        <button className="btn btn-primary" onClick={() => openRepo(repoPathInput)} data-testid="open-btn">Open</button>
        <div className="status" title={status} data-testid="status" data-status={status}>
          <span className={`status-dot ${status === "live" ? "live" : status === "error" ? "err" : ""}`} />
          <span>{statusLabel(status, repoInfo)}</span>
        </div>
      </header>

      <div className="main">
        <aside className="sidebar">
          <ModePicker
            mode={mode}
            onChange={setMode}
            repoInfo={repoInfo}
            commits={commits}
            disabled={!repoInfo}
          />
          <RecentRepos
            recent={recent}
            current={repoPath}
            onPick={(p) => { setRepoPathInput(p); openRepo(p); }}
          />
        </aside>

        <main className="content">
          {error && <div className="error">⚠ {error}</div>}
          {!repoInfo && !error && (
            <div className="empty">
              <h2>Open a repository to begin.</h2>
              <p style={{ color: "var(--muted)" }}>
                Paste an absolute path above and press Enter, or pick one from the recent list.
              </p>
            </div>
          )}
          {repoInfo && (
            <DiffView files={parsed} stat={stat} highlighterReady={highlighterReady} />
          )}
        </main>
      </div>
    </div>
  );
}

// ─── Mode Picker ───────────────────────────────────────────────────────────
function ModePicker({
  mode, onChange, repoInfo, commits, disabled,
}: {
  mode: DiffMode;
  onChange: (m: DiffMode) => void;
  repoInfo: RepoInfo | null;
  commits: Commit[];
  disabled: boolean;
}) {
  const branches = repoInfo?.branches ?? [];
  const currentBranch = repoInfo?.currentBranch ?? "";

  return (
    <section>
      <div className="label">Mode</div>
      <div className="modes">
        <button
          className={`mode ${mode.kind === "workingTree" ? "active" : ""}`}
          disabled={disabled}
          onClick={() => onChange({ kind: "workingTree" })}
        >Working Tree vs HEAD</button>
        <button
          className={`mode ${mode.kind === "staged" ? "active" : ""}`}
          disabled={disabled}
          onClick={() => onChange({ kind: "staged" })}
        >Staged vs HEAD</button>
        <button
          className={`mode ${mode.kind === "branch" ? "active" : ""}`}
          disabled={disabled}
          onClick={() => onChange({
            kind: "branch",
            base: branches.find((b) => b !== currentBranch) ?? currentBranch,
            head: currentBranch,
          })}
        >Branch Diff</button>
        <button
          className={`mode ${mode.kind === "commit" ? "active" : ""}`}
          disabled={disabled}
          onClick={() => onChange({
            kind: "commit",
            sha: commits[0]?.sha ?? (repoInfo?.head ?? ""),
          })}
        >Commit</button>
      </div>

      {mode.kind === "branch" && (
        <div style={{ marginTop: "0.75rem" }}>
          <div className="field">
            <label className="label">Base</label>
            <select
              className="input"
              value={mode.base}
              onChange={(e) => onChange({ kind: "branch", base: e.target.value, head: mode.head })}
            >
              {branches.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="label">Head</label>
            <select
              className="input"
              value={mode.head}
              onChange={(e) => onChange({ kind: "branch", base: mode.base, head: e.target.value })}
            >
              {branches.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
        </div>
      )}

      {mode.kind === "commit" && (
        <div style={{ marginTop: "0.75rem" }}>
          <div className="field">
            <label className="label">Commit</label>
            <select
              className="input"
              value={mode.sha}
              onChange={(e) => onChange({ kind: "commit", sha: e.target.value })}
            >
              {commits.length === 0 && <option value={mode.sha}>{mode.sha || "(no commits)"}</option>}
              {commits.map((c) => (
                <option key={c.sha} value={c.sha}>
                  {c.short} — {truncate(c.subject, 56)}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </section>
  );
}

// ─── Recent Repos ──────────────────────────────────────────────────────────
function RecentRepos({
  recent, current, onPick,
}: { recent: string[]; current: string; onPick: (p: string) => void; }) {
  if (recent.length === 0) return null;
  return (
    <section style={{ marginTop: "1.5rem" }}>
      <div className="label">Recent</div>
      <ul className="recent" style={{ marginTop: "0.25rem" }} data-testid="recent-list">
        {recent.map((p) => (
          <li
            key={p}
            className={p === current ? "active" : ""}
            onClick={() => onPick(p)}
            title={p}
            data-testid="recent-item"
            data-path={p}
            style={p === current ? { color: "var(--text)", background: "var(--bg-3)" } : undefined}
          >
            {shortenPath(p)}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ─── Diff View ─────────────────────────────────────────────────────────────
function DiffView({ files, stat, highlighterReady }: {
  files: DiffFile[];
  stat: DiffStat | null;
  highlighterReady: boolean;
}) {
  if (files.length === 0) {
    return <div className="empty"><h2>No changes.</h2></div>;
  }
  return (
    <>
      {stat && (
        <div className="summary">
          <span>{stat.files.length} file{stat.files.length === 1 ? "" : "s"}</span>
          <span style={{ color: "var(--green)" }}>+{stat.totalAdditions}</span>
          <span style={{ color: "var(--red)" }}>−{stat.totalDeletions}</span>
        </div>
      )}
      {files.map((f, idx) => (
        <FileDiff key={`${f.newPath}:${idx}`} file={f} highlighterReady={highlighterReady} />
      ))}
    </>
  );
}

const FileDiff = React.memo(function FileDiff({ file, highlighterReady }: {
  file: DiffFile;
  highlighterReady: boolean;
}) {
  const [open, setOpen] = useState(true);
  const name = file.newPath || file.oldPath;
  const renamed = file.oldPath && file.newPath && file.oldPath !== file.newPath;
  const language = useMemo(() => langFromPath(name), [name]);

  // Per-hunk highlight: array of arrays of per-line HTML strings.
  // Depends on `highlighterReady` so we re-render once shiki boots.
  const highlighted = useMemo(
    () => file.hunks.map((h) => highlightHunk(h, language)),
    [file.hunks, language, highlighterReady]
  );

  return (
    <div className="file" data-testid="file-diff" data-file={name}>
      <div className="file-header" onClick={() => setOpen((v) => !v)} style={{ cursor: "pointer" }}>
        <span className="chevron">{open ? "▾" : "▸"}</span>
        <span className="file-name">
          {renamed ? `${file.oldPath} → ${file.newPath}` : name}
        </span>
        {file.binary && <span className="file-status">binary</span>}
      </div>
      {open && !file.binary && file.hunks.map((h, i) => (
        <div className="hunk" key={i}>
          <div className="hunk-header">{h.header}</div>
          {h.lines.map((l, j) => (
            <div className={`line ${l.kind}`} key={j}>
              <span className="line-num">{l.oldNum ?? ""}</span>
              <span className="line-num">{l.newNum ?? ""}</span>
              <span className="line-content">
                <span className="line-marker">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
                <span
                  className="line-code"
                  dangerouslySetInnerHTML={{ __html: highlighted[i]?.[j] ?? "" }}
                />
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
});

// ─── Helpers ───────────────────────────────────────────────────────────────
function statusLabel(s: string, info: RepoInfo | null): string {
  if (s === "connecting") return "connecting…";
  if (s === "error") return "error";
  if (s === "live" && info) return `live · ${info.currentBranch} @ ${info.head}`;
  return "idle";
}
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function shortenPath(p: string): string {
  const home = "/Users/";
  if (p.startsWith(home)) {
    const parts = p.split("/");
    return "~/" + parts.slice(3).join("/");
  }
  return p;
}
