# 🌈 Diffraction

> A beautiful, secure, local-only git diff viewer that runs in your browser.

Four diff modes. Live sync on file save. GitHub-style word-level highlighting layered over Shiki syntax coloring. No cloud, no telemetry — just a Bun process bound to `127.0.0.1` with a single-use token.

---

## Quickstart

```bash
git clone git@github.com:fourcolors/diffraction.git
cd diffraction
bun install
cd web && bun install && bun run build && cd ..
bun run dev
```

The terminal prints a URL with a random token:

```
Open: http://localhost:5173/?t=aef47d522ea2da58e...
```

Open it, paste an absolute repo path, pick a mode, and go.

---

## What it does

### Four diff modes

| Mode | What you see |
|------|-------------|
| **Working Tree vs HEAD** | Uncommitted, unstaged changes |
| **Staged vs HEAD** | Only what's in the index |
| **Branch Diff** | Three-dot merge-base diff (`base...head`) — matches GitHub's PR view |
| **Commit** | A single commit's patch, pick from a dropdown of recent SHAs |

### Live sync

The backend watches the repo with chokidar (debounced at 200ms) and polls `.git/HEAD` + `for-each-ref` every 1.5s. When anything changes, the active WebSocket pushes a fresh diff + stats. You'll see working-tree edits, new commits, and branch resets within ~1 second — no refresh.

### Word-level intra-line diff

When an edit is a small change to an existing line, Diffraction pairs the removed and added lines via line-level LCS (+ Jaccard fallback), then runs a token-level diff to highlight only the bits that changed. Shiki's syntax coloring stays intact underneath; the word-diff bg layers on top.

### Syntax highlighting

Shiki's `github-dark-dimmed` theme. The following languages are preloaded; rarer extensions fall back to plaintext:

```
ts, tsx, js, jsx, py, md, json, yaml, css, html, sh
```

---

## Architecture

```
Backend (Bun, 127.0.0.1 only)            Frontend (Vite + React 19)
───────────────────────────────           ──────────────────────────────
server/                                   web/src/
├── git.ts       4 diff modes,            ├── App.tsx       mode picker, WS
│                hardened spawn           │                  lifecycle, recents
├── watcher.ts   chokidar + 1.5s          ├── parseDiff.ts  unified-diff parser
│                ref polling               │                 → file/hunk/line AST
└── index.ts     token gate, DNS          ├── highlight.ts  Shiki per-hunk cache
                 rebind defense,          ├── wordDiff.ts   LCS pair + diff tokens
                 SPA serve                └── styles.css
```

### Security model

Diffraction runs **locally** and never connects to an external service. Every layer assumes a hostile browser in the same origin:

- **Bind**: hostname pinned to `127.0.0.1`. No LAN access.
- **Token**: a random 16-byte hex string is generated at startup (override with `DIFFRACTION_TOKEN` env var). All `/api/*` and `/ws` requests require `?t=<token>`.
- **DNS rebinding defense**: `Host` header must be `localhost` or `127.0.0.1` — requests pretending to reach you from `evil.example.com` are rejected with 403.
- **Git hardening**: every `git` child process runs with `GIT_CONFIG_NOSYSTEM=1`, `core.hooksPath=/dev/null`, `core.fsmonitor=`, `protocol.ext.allow=never`. Opening a malicious repo can't execute code.
- **Path validation**: user-supplied repo paths must be absolute and contain a `.git/` subdirectory.
- **Ref validation**: branch names and SHAs must match `^[a-zA-Z0-9_./\-]+$` — no argv injection.

---

## API surface

All endpoints require `?t=<TOKEN>`. Content-Type `application/json` where applicable.

| Method | Path | Returns |
|--------|------|---------|
| `GET` | `/api/repo/info?path=<abs>` | `{path, currentBranch, branches[], head}` |
| `POST` | `/api/diff` body `{path, mode, base?, head?, sha?}` | `{diff, stat:{files[], totalAdditions, totalDeletions}}` |
| `GET` | `/api/commits?path=<abs>&limit=50` | `[{sha, short, subject, author, date}]` |
| `GET` | `/api/config` | `{version}` |

### WebSocket

Connect to `ws://127.0.0.1:<port>/ws?t=<TOKEN>`.

```jsonc
// Client → Server
{ "type": "subscribe", "path": "/abs/repo", "mode": "workingTree" }
{ "type": "subscribe", "path": "/abs/repo", "mode": "branch", "base": "main", "head": "feature" }
{ "type": "unsubscribe" }

// Server → Client
{ "type": "diff", "diff": "<unified diff>", "stat": { ... } }
{ "type": "error", "message": "..." }
```

---

## Development

```bash
# Backend dev (serves built SPA)
bun run dev

# Vite dev server with HMR (proxies /api + /ws to backend on 5173)
bun run dev:web        # port 5174

# Build production SPA
bun run build:web

# Unit tests (Bun, 40 tests across git layer + wordDiff)
bun test

# Playwright browser e2e (live sync + repo switching)
bun run test:e2e
bun run test:e2e:ui    # interactive mode
```

### Tests

| Suite | What it covers | Count |
|-------|---------------|-------|
| `test/git.test.ts` | Ref validation, diff args, mode resolver, path validation | 19 |
| `test/server.test.ts` | HTTP/WS surface, token gate, DNS rebind, static serve | 13 |
| `test/wordDiff.test.ts` | LCS pairing, Jaccard threshold, HTML run wrapping, perf cap | 8 |
| `e2e/live-sync.spec.ts` | Scenario 5: file change → diff update | 1 |
| `e2e/repo-switching.spec.ts` | Scenario 6: switch repos → recent list populated | 1 |

### BDD scenarios

Behavior is specified in `features/diff-modes.md` — six Given/When/Then scenarios plus security invariants. The test suites are the executable form of that spec.

---

## Config

| Env var | Default | Purpose |
|---------|---------|---------|
| `PORT` | `5173` | HTTP + WS port |
| `DIFFRACTION_TOKEN` | random hex | Session token (override for scripting/tests) |

---

## Stack

- [**Bun**](https://bun.sh) — HTTP + WebSocket server + test runner
- [**React 19**](https://react.dev) — UI
- [**Vite 6**](https://vitejs.dev) — build
- [**Shiki**](https://shiki.matsu.io) — syntax highlighting
- [**chokidar**](https://github.com/paulmillr/chokidar) — file watching
- [**diff**](https://github.com/kpdecker/jsdiff) — word-level intra-line diffs
- [**Playwright**](https://playwright.dev) — browser e2e

---

## License

MIT
