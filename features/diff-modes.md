# Diffraction — BDD Scenarios (v1 MVP)

## Scenario 1: Working tree diff (uncommitted changes)
**Given** a git repo with a committed file `README.md`
**And** I modify `README.md` without staging
**When** I open Diffraction and select the repo
**And** I choose mode "Working Tree vs HEAD"
**Then** I see the modified lines in `README.md` as a diff

## Scenario 2: Staged diff
**Given** a git repo with a committed file
**And** I modify and `git add` the file
**When** I choose mode "Staged vs HEAD"
**Then** I see the staged changes only, not unstaged ones

## Scenario 3: Branch vs branch (merge-base three-dot)
**Given** a repo with `main` and a `feature` branch that has 2 new commits
**When** I choose mode "Branch Diff" with base=main, head=feature
**Then** I see the total merge-worth of changes — equivalent to `git diff main...feature`
**And** the diff matches what GitHub would show for a PR

## Scenario 4: Single commit
**Given** a repo with commit SHA `abc123`
**When** I choose mode "Commit" with that SHA
**Then** I see the diff introduced by that commit only

## Scenario 5: Live sync
**Given** I am viewing "Working Tree vs HEAD" for a repo
**When** I modify a file in that repo from outside Diffraction
**Then** the diff updates within 1 second without a manual refresh

## Scenario 6: Repo switching
**Given** I have previously opened repo A
**When** I switch to repo B
**Then** Diffraction shows repo B's branches and diffs
**And** repo A appears in the "recent repos" list

## Security invariants
- Backend binds to 127.0.0.1 only
- Every API request requires the session token (printed in startup URL)
- Requests without valid `Host: localhost:<port>` are rejected
- Git spawned with `GIT_CONFIG_NOSYSTEM=1`, `core.hooksPath=/dev/null`, `core.fsmonitor=`
- Repo paths validated as absolute + containing `.git/` before use
