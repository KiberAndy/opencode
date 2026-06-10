import { SessionV1 } from "@opencode-ai/core/v1/session"

/**
 * Tool names whose completed outputs are never evicted by the smart GC.
 * Mirrors the protection list used by SessionCompaction's FIFO prune
 * (see compaction.ts:PRUNE_PROTECTED_TOOLS). Kept in sync intentionally —
 * skill outputs encode persistent agent instructions that must survive
 * eviction even when a later call references the same input.
 */
export const PROTECTED_TOOLS: readonly string[] = ["skill"]

const READ_TOOLS: readonly string[] = ["read"]
const MODIFY_TOOLS: readonly string[] = ["edit", "write", "apply_patch"]
const SHELL_TOOLS: readonly string[] = ["bash"]

/**
 * Configuration for the deterministic, content-aware eviction pass.
 *
 * Each rule answers a specific "this tool result is no longer useful"
 * question. Rules are independent — disabling one does not affect the
 * others. Defaults are deliberately conservative: only rules whose
 * eviction is provably lossless on every replay are enabled by default.
 */
export interface Rules {
  /**
   * Drop earlier `read` results for the same `filePath`. The latest
   * read of a path always reflects the current intent; older reads
   * (whether overlapping ranges or not) cannot add information the
   * model needs.
   *
   * Default: true.
   */
  dedupe_reads?: boolean
  /**
   * Drop all earlier `read` results for any `filePath` that a later
   * `edit`, `write`, or `apply_patch` modified. The old contents are
   * now stale and actively misleading — the file no longer matches what
   * the model would see if it re-read.
   *
   * Default: true.
   */
  evict_on_modify?: boolean
  /**
   * Drop earlier `bash` results that share the exact same `command`.
   * Off by default because shell commands frequently produce
   * time-sensitive output (`ls`, `git status`, `date`) where the model
   * may legitimately want both invocations in scope.
   *
   * Default: false.
   */
  dedupe_shell?: boolean
  /**
   * Drop earlier `grep` results with the same `pattern`, `path`, and
   * `include`. Off by default because grep is often used iteratively
   * with narrowing arguments where the older, broader result is still
   * relevant.
   *
   * Default: false.
   */
  dedupe_grep?: boolean
  /**
   * Drop earlier `glob` results with the same `pattern` and `path`.
   * Off by default for the same reason as `dedupe_grep`.
   *
   * Default: false.
   */
  dedupe_glob?: boolean
  /**
   * Drop earlier `webfetch` results for the same URL. On by default —
   * the model rarely benefits from two snapshots of the same URL in
   * context, and webfetch outputs are typically large.
   *
   * Default: true.
   */
  dedupe_webfetch?: boolean
}

/**
 * Resolved view of a completed tool call inside a message list,
 * carrying enough indexing to mutate or replace the original part.
 */
export interface ToolCallRef {
  readonly messageIndex: number
  readonly partIndex: number
  readonly part: SessionV1.ToolPart
}

/**
 * Whether the rule set has at least one active rule. Cheap guard for
 * callers that want to skip building the call list when GC is a no-op.
 */
export function isActive(rules: Rules | undefined): boolean {
  if (!rules) return true
  return (
    rules.dedupe_reads !== false ||
    rules.evict_on_modify !== false ||
    rules.dedupe_shell === true ||
    rules.dedupe_grep === true ||
    rules.dedupe_glob === true ||
    rules.dedupe_webfetch !== false
  )
}

/**
 * Flatten a message list into the completed tool calls in chronological
 * order. Only completed parts are returned; pending/running/error parts
 * are skipped because their `state.output` either does not exist yet or
 * is not used by `toModelMessagesEffect`.
 */
export function collectCompletedToolCalls(messages: readonly SessionV1.WithParts[]): ToolCallRef[] {
  return messages.flatMap((msg, messageIndex) =>
    msg.parts.flatMap((part, partIndex): ToolCallRef[] => {
      if (part.type !== "tool") return []
      if (part.state.status !== "completed") return []
      return [{ messageIndex, partIndex, part }]
    }),
  )
}

/**
 * Compute the set of `callID`s that should be evicted (their tool
 * `state.time.compacted` set so the model sees a placeholder on the
 * next render).
 *
 * This function is **pure**: it produces a decision, it does not mutate
 * the messages. The caller — typically `SessionCompaction.prune` —
 * applies the decision via `session.updatePart`.
 *
 * Ordering guarantees:
 * - Already-compacted parts are never returned (idempotent).
 * - Already-evicted-by-an-earlier-rule parts may still appear in the
 *   set; the caller is expected to dedupe against the live message
 *   state before mutating.
 * - Protected tool names (see `PROTECTED_TOOLS`) are never returned.
 */
export function selectEvictions(messages: readonly SessionV1.WithParts[], rules: Rules = {}): Set<string> {
  const calls = collectCompletedToolCalls(messages)
  if (calls.length === 0) return new Set()

  const evict = new Set<string>()
  const tag = (id: string) => evict.add(id)

  if (rules.dedupe_reads !== false) {
    applyDedupeReads(calls, tag)
  }
  if (rules.evict_on_modify !== false) {
    applyEvictOnModify(calls, tag)
  }
  if (rules.dedupe_shell === true) {
    applyDedupeByKey(calls, SHELL_TOOLS, shellKey, tag)
  }
  if (rules.dedupe_grep === true) {
    applyDedupeByKey(calls, ["grep"], grepKey, tag)
  }
  if (rules.dedupe_glob === true) {
    applyDedupeByKey(calls, ["glob"], globKey, tag)
  }
  if (rules.dedupe_webfetch !== false) {
    applyDedupeByKey(calls, ["webfetch"], webfetchKey, tag)
  }

  // Protected tools are never evicted regardless of rule matches.
  for (const c of calls) {
    if (PROTECTED_TOOLS.includes(c.part.tool)) evict.delete(c.part.callID)
  }
  // Already-compacted parts are no-op evictions; remove for cleanliness.
  for (const c of calls) {
    if (c.part.state.status === "completed" && c.part.state.time.compacted) evict.delete(c.part.callID)
  }
  return evict
}

// --- Rule implementations ---------------------------------------------------

function applyDedupeReads(calls: readonly ToolCallRef[], tag: (id: string) => void): void {
  const lastByPath = new Map<string, string>()
  for (const c of calls) {
    if (!READ_TOOLS.includes(c.part.tool)) continue
    if (c.part.state.status !== "completed") continue
    const filePath = pickString(c.part.state.input, "filePath")
    if (filePath === undefined) continue
    const previous = lastByPath.get(filePath)
    if (previous !== undefined) tag(previous)
    lastByPath.set(filePath, c.part.callID)
  }
}

function applyEvictOnModify(calls: readonly ToolCallRef[], tag: (id: string) => void): void {
  const readsByPath = new Map<string, string[]>()
  const dropReadsFor = (path: string) => {
    const ids = readsByPath.get(path)
    if (!ids) return
    for (const id of ids) tag(id)
    readsByPath.delete(path)
  }

  for (const c of calls) {
    if (c.part.state.status !== "completed") continue

    if (READ_TOOLS.includes(c.part.tool)) {
      const filePath = pickString(c.part.state.input, "filePath")
      if (filePath === undefined) continue
      const list = readsByPath.get(filePath) ?? []
      list.push(c.part.callID)
      readsByPath.set(filePath, list)
      continue
    }

    if (!MODIFY_TOOLS.includes(c.part.tool)) continue

    // edit / write have a single `filePath` in their input.
    const direct = pickString(c.part.state.input, "filePath")
    if (direct !== undefined) {
      dropReadsFor(direct)
      continue
    }
    // apply_patch records affected file paths in metadata.files[].filePath.
    for (const path of patchedFilePaths(c.part)) dropReadsFor(path)
  }
}

function applyDedupeByKey(
  calls: readonly ToolCallRef[],
  toolNames: readonly string[],
  keyOf: (input: Record<string, unknown>) => string | undefined,
  tag: (id: string) => void,
): void {
  const lastByKey = new Map<string, string>()
  for (const c of calls) {
    if (!toolNames.includes(c.part.tool)) continue
    if (c.part.state.status !== "completed") continue
    const key = keyOf(c.part.state.input)
    if (key === undefined) continue
    const previous = lastByKey.get(key)
    if (previous !== undefined) tag(previous)
    lastByKey.set(key, c.part.callID)
  }
}

// --- Per-tool key functions -------------------------------------------------

function shellKey(input: Record<string, unknown>): string | undefined {
  const command = pickString(input, "command")
  if (command === undefined) return undefined
  // cwd may legitimately scope the command — include it so `ls` in /a and /b
  // are not deduped against each other.
  return `${pickString(input, "cwd") ?? ""}\u0000${command}`
}

function grepKey(input: Record<string, unknown>): string | undefined {
  const pattern = pickString(input, "pattern")
  if (pattern === undefined) return undefined
  return `${pattern}\u0000${pickString(input, "path") ?? ""}\u0000${pickString(input, "include") ?? ""}`
}

function globKey(input: Record<string, unknown>): string | undefined {
  const pattern = pickString(input, "pattern")
  if (pattern === undefined) return undefined
  return `${pattern}\u0000${pickString(input, "path") ?? ""}`
}

function webfetchKey(input: Record<string, unknown>): string | undefined {
  return pickString(input, "url")
}

// --- Helpers ----------------------------------------------------------------

function pickString(input: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!input) return undefined
  const value = input[key]
  return typeof value === "string" ? value : undefined
}

function patchedFilePaths(part: SessionV1.ToolPart): string[] {
  if (part.state.status !== "completed") return []
  const files = part.state.metadata?.["files"]
  if (!Array.isArray(files)) return []
  return files.flatMap((entry): string[] => {
    if (!entry || typeof entry !== "object") return []
    const record = entry as Record<string, unknown>
    const filePath = pickString(record, "filePath")
    if (filePath === undefined) return []
    const movePath = pickString(record, "movePath")
    return movePath !== undefined ? [filePath, movePath] : [filePath]
  })
}

export * as ContextGC from "./context-gc"
