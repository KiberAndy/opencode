---
name: opencode-fork
description: Maintenance log and playbook for KiberAndy's personal opencode fork (this repo). Load this BEFORE debugging build failures, "Failed to send prompt" / server errors, version or free-tier gate errors, bun.lock or turbo/workspace warnings, or anything related to update-fork.ps1 / build-fork.ps1 / continue-update.ps1. Check the problem log here first, since the issue may already be diagnosed and fixed. Always append a new entry after fixing something new in this fork, and record any deliberate local-only patch here too.
---

# opencode-fork maintenance log

This file is the memory for maintaining **this specific fork** (`origin` = KiberAndy/opencode,
`upstream` = anomalyco/opencode). It is not upstream documentation -- it only exists to stop
re-diagnosing the same problem twice across sessions/agents.

**Workflow when asked to fix something in this fork:**
1. Read the "Problem log" below first. If the symptom matches an existing entry, re-check whether
   its fix is still present before re-investigating from scratch (e.g. `git log --oneline -- <file>`
   for the commit mentioned in the entry).
2. If it's a new problem, fix it, then add a new entry at the **top** of the Problem log following
   the existing format: Symptom, Root cause, Fix, Verification, Commit(s).
3. If you deliberately add a local-only, non-portable workaround (something that should never be
   pushed to `origin/fork` as-is), record it under "Local-only workarounds" instead of the problem
   log, so nobody "cleans it up" by accident or re-discovers it confused.

## Fork facts

- `origin` -> `https://github.com/KiberAndy/opencode.git` (KiberAndy's fork, push target).
- `upstream` -> `https://github.com/anomalyco/opencode.git` (real upstream).
- `dev` branch is reset to a specific upstream release tag (never has fork patches).
- `fork` branch is `dev` + all personal patches, kept up to date by rebasing onto `dev` after
  `dev` is bumped to a newer tag.
- Root scripts drive the whole update/build/publish cycle:
  - `update-fork.ps1` -- fetches upstream tags, resets `dev` to a chosen tag, pushes `dev`, then
    rebases `fork` onto `dev`. On conflict it writes `continue-update.ps1` and stops.
  - `continue-update.ps1` -- run after manually resolving rebase conflicts (`git add` + verifying no
    unmerged paths remain); finishes `git rebase --continue` and pushes `fork`.
  - `build-fork.ps1` -- `bun install` then `bun run --cwd packages/opencode build -- --single`. It
    does **not** itself deploy the built binary anywhere; how `dist/opencode-windows-x64/bin/opencode.exe`
    ends up as the globally-invoked `opencode` command was not traced end-to-end -- if a fix doesn't
    seem to take effect after rebuilding, verify the *actual* running binary's reported version/timestamp
    before assuming the build is stale (see "Verifying a build actually contains a fix" below).
- Preview/fork builds are versioned as `<nearest-upstream-tag>-<channel>-<UTC timestamp>`
  (e.g. `1.18.31-fork-202609171521`), computed in `packages/script/src/index.ts`. This is dynamic --
  it always reflects whatever tag `dev`/`fork` currently sit on, no manual bump needed after a rebase.

### Verifying a build actually contains a fix

Rebuilding is fast (`bun run --cwd packages/opencode build -- --single --sourcemaps --skip-install
--skip-embed-web-ui` takes ~10s once deps are installed) and `--sourcemaps` turns the otherwise
minified, useless stack traces (`chunk-xxxx.js:2:1659`) into real `src/...` file:line references --
always add it while debugging a crash in this fork. To reproduce a crash quickly without burning
model credits, `opencode run "hi" --print-logs --log-level DEBUG` against the built
`dist/opencode-windows-x64/bin/opencode.exe` directly (not the globally-installed shim) is enough;
most of the historical bugs here reproduced during session bootstrap, before any real model call.

## Local-only workarounds (do not "clean up" or blindly commit)

- **`packages/app/package.json`: `ghostty-web` pinned to `file:G:/FORK/opencode/packages/app/vendor/ghostty-web`
  instead of the `github:anomalyco/ghostty-web#<sha>` upstream spec.** Bun could not download that
  GitHub-hosted dependency on this machine (the repo clones fine standalone, just not through bun's
  dependency fetch), so the repo is vendored locally under `packages/app/vendor/ghostty-web/` instead.
  This is intentionally left **uncommitted** -- the `file:` path is an absolute local path
  (`G:/FORK/opencode/...`) and would break the build on any other machine or checkout location. Keep
  it as a standing local diff; don't commit it as-is, and don't revert it thinking it's stray noise.

## Problem log

(Newest first. One entry per distinct root cause.)

### 2026-09-17 -- Turbo can't parse `bun.lock`, loses workspace graph
- **Symptom:** every `bun run typecheck` / `bun turbo ...` printed a warning before running:
  `WARNING An issue occurred while attempting to parse bun.lock ... Could not resolve workspaces.
  Unsupported bun lockfile version: 2`. Non-fatal (turbo fell back to filesystem-based package
  discovery) but noisy and lost cross-package remote/local cache correctness.
- **Root cause:** Bun 1.4+ (installed here: 1.4.2) writes `bun.lock` with `"lockfileVersion": 2`.
  The `turbo` version pinned in root `package.json` (2.10.2) only understood lockfile versions 0/1.
  This is a known upstream Turborepo bug, not specific to this fork:
  https://github.com/vercel/turborepo/issues/13117, fixed by
  https://github.com/vercel/turborepo/pull/13119, shipped in turbo **2.10.3**.
- **Fix:** bumped `"turbo"` in root `package.json` from `2.10.2` to `2.10.3`, ran `bun install`.
- **Verification:** `bun run typecheck` -- warning gone, all 36 packages resolved from the workspace
  graph, all 30 typecheck tasks passed.
- **Commit:** `cf13e06451` -- "chore: bump turbo to 2.10.3, finalize bun.lock"

### 2026-09-17 -- `bun.lock` stuck as an unresolved git conflict since an earlier rebase
- **Symptom:** `git status` permanently showed `DU bun.lock` ("deleted by us") no matter what was
  done to the file on disk -- deleting it and letting `bun install` regenerate it did **not** clear
  the status.
- **Root cause:** an earlier `update-fork.ps1` run hit a conflict on `bun.lock`, and the conflict
  was never actually resolved with `git add`/`git rm` before the rebase was continued and finished.
  `git ls-files -u bun.lock` showed only stage 1 (common ancestor) and stage 3 ("theirs") -- no stage
  2 ("ours") at all, meaning the *committed* `fork` branch tip had no `bun.lock` in its tree whatsoever.
  Conflict resolution lives in the git **index**, not in the working-tree file, so regenerating the
  file on disk alone can never fix this -- only `git add`/`git rm` on the conflicted path does.
- **Initial false lead:** this was suspected as the cause of the "Failed to send prompt" crash below.
  It wasn't -- dependency installation was actually fine and consistent; this was purely a leftover
  git bookkeeping issue. Don't re-chase this angle for unrelated runtime bugs; check "Root cause" of
  the crash entry below instead.
- **Fix:** confirmed `bun.lock` on disk was valid (no conflict markers, `bun install` happy with it,
  typecheck green), then `git add bun.lock` to accept it as the resolution and commit it.
- **Verification:** `git status` no longer lists `bun.lock` as unmerged; it's a normal tracked file.
- **Commit:** `cf13e06451` (bundled with the turbo bump above, since regenerating the lockfile is
  what finally produced a clean file to stage).

### 2026-09-17 -- Free tier: "OpenCode 1.17.0 or newer is required to use the free tier"
- **Symptom:** the `opencode` provider's free models (`muse-spark-1.3-contributor-free`, `big-pickle`)
  started failing with `AI_APICallError: Error from provider (Console): OpenCode 1.17.0 or newer is
  required to use the free tier`. Worked fine a few days earlier; nothing in this fork's own code
  changed that would explain it.
- **Root cause:** preview/non-`latest`-channel builds (this fork always builds on a git branch name,
  never `latest`) were versioned as `0.0.0-<channel>-<timestamp>` (`packages/script/src/index.ts`).
  This version string is sent as the client's `User-Agent`/reported version
  (`packages/core/src/installation/version.ts` -> used everywhere as `InstallationVersion`). Under
  semver, a bare `0.0.0` major.minor.patch always compares as *older* than any real release, so once
  opencode.ai's Console started gating the free tier on a minimum client version, every preview/fork
  build failed the check regardless of how new the underlying code actually was -- this fork is built
  on top of upstream tag v1.18.31, far newer than the v1.17.0 floor.
- **Fix:** `packages/script/src/index.ts` now derives the preview version's base from
  `git describe --tags --abbrev=0 HEAD` (the nearest upstream release tag reachable from the current
  commit) instead of hardcoding `0.0.0`, e.g. `1.18.31-fork-202609171521`. This is computed fresh at
  every build, so it stays correct automatically after every future `update-fork.ps1` rebase -- no
  manual version bump needed.
- **Verification:** rebuilt, `opencode --version` -> `1.18.31-fork-<timestamp>`; `opencode run` against
  the free-tier `build` agent model no longer hits the version-gate error (only an unrelated
  "No payment method" error remains for a *different*, non-free model that genuinely needs billing
  set up on the account -- that's expected and out of scope for this fork).
- **Commit:** `92755f6808` -- "fix(script): base fork/preview version off the nearest release tag"
- **Note:** this fixes the specific mechanism observed (a semver comparison against the reported
  client version). If opencode.ai ever changes *how* they gate the free tier (e.g. an explicit
  allow-list of official builds), this fix may stop being sufficient -- it is not a guaranteed
  permanent bypass, just an honest, correct version string.

### 2026-09-17 -- TUI: "Failed to send prompt -- Unexpected server error" (every session, every project except this repo itself)
- **Symptom:** any prompt in any project directory other than `G:\FORK\opencode` itself failed
  immediately with a generic "Unexpected server error" toast. Server logs showed, repeatedly, at
  session bootstrap and on every prompt:
  ```
  TypeError: undefined is not an object (evaluating 'a.name')
      at resolve (chunk-xxxx.js:2:1659)
      ... (3 levels of nested .map) ...
      at SystemPrompt.environment (chunk-xxxx.js:...)
  ```
- **Investigation dead end (don't repeat):** first suspected an in-progress `git rebase` conflict on
  `bun.lock` (there really was one -- see the entry above) as the cause via a broken/partial `bun
  install`. Ruled out: `bun install` was clean and consistent, all workspace packages correctly
  symlinked. That conflict was real but unrelated to this crash.
- **Key reproduction fact:** the crash reproduced 100% of the time in the **compiled** binary
  (`bun build --compile`) but never when running the exact same code straight from source
  (`bun run --cwd packages/opencode src/index.ts run ...`). That immediately rules out "a logic bug
  in a patch" and points at something specific to bundling/code-splitting.
- **Root cause:** rebuilding with `--sourcemaps` turned the minified trace into real file:line refs
  pointing at `packages/core/src/effect/layer-node.ts`'s dependency-graph walker (`walk`/`resolve`).
  It was crashing because some `LayerNode`'s `deps` array contained `undefined` instead of a real
  node. Traced to `packages/core/src/filesystem.ts` <-> `packages/core/src/filesystem/search.ts`: the
  two modules imported each other's runtime values at module top level (a genuine circular import).
  Plain `bun run`/Node ESM resolves this kind of cycle correctly (the importee finishes initializing
  before the importer's top-level code needs it), but `bun build --compile` with `splitting: true`
  does not preserve that ordering reliably across generated chunks, so `FileSystemSearch.node` was
  still `undefined` when `filesystem.ts`'s top-level `LayerNode.make({ ..., deps: [...] })` ran.
- **Fix (two parts):**
  1. `packages/core/src/filesystem/search.ts` no longer imports the `FileSystem` namespace as a
     runtime value from `../filesystem`. It imports `Entry`/`Match`/`FindInput` directly from
     `@opencode-ai/schema/filesystem` (their real source; `filesystem.ts` only re-exports them), and
     takes a `import type { FileSystem }` for the `GlobInput`/`GrepInput` type references only -- a
     type-only import erases at build time, so the runtime cycle is gone entirely rather than just
     hidden.
  2. `packages/core/src/effect/layer-node.ts`'s `make()` now validates `deps` eagerly and throws a
     clear `LayerNode.make("<name>"): dependency at index N is undefined ...` error immediately at
     module load instead of failing deep in a generic tree walk later. If a similar circular-import
     regression shows up again (in this file pair or a different one), this should immediately name
     the broken node instead of requiring another multi-hour trace.
- **Verification:** rebuilt with `--sourcemaps`, ran `opencode run "hi" --print-logs --log-level DEBUG`
  repeatedly against `G:\Projects\Bluetooth_Force` and `C:\Users\Andy` (the two directories that
  reliably reproduced it) -- zero occurrences of the `TypeError` afterward, across multiple runs.
- **Commits:** `9fecb5ae14` (layer-node.ts guard), `a32b5945ba` (search.ts circular-import fix)
