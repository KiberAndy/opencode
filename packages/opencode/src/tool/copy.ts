import z from "zod"
import * as path from "path"
import { Effect, Semaphore } from "effect"
import * as Tool from "./tool"
import { LSP } from "../lsp"
import { createTwoFilesPatch, diffLines } from "diff"
import DESCRIPTION from "./copy.txt"
import { Bus } from "../bus"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { Format } from "../format"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Instance } from "../project/instance"
import { trimDiff } from "./edit"
import { assertExternalDirectoryEffect } from "./external-directory"

// ─────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────

class CopyToolError extends Error {
  readonly reason: string

  constructor(props: { reason: string; message: string }) {
    super(props.message)
    this.name = "CopyToolError"
    this.reason = props.reason
  }
}

// ─────────────────────────────────────────────
// Per-file semaphore registry
// ─────────────────────────────────────────────

const fileLocks = new Map<string, Semaphore.Semaphore>()

function getLock(absolutePath: string): Semaphore.Semaphore {
  const existing = fileLocks.get(absolutePath)
  if (existing !== undefined) return existing
  const sem = Semaphore.makeUnsafe(1)
  fileLocks.set(absolutePath, sem)
  return sem
}

// ─────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────

const Parameters = z.object({
  sourceFile: z
    .string()
    .min(1)
    .describe("The file to copy from (absolute or relative path)"),
  sourceString: z
    .string()
    .optional()
    .describe(
      "The exact text block to copy from sourceFile. " +
        "Must match exactly including whitespace and indentation. " +
        "Optional when sourceLineStart/sourceLineEnd are provided.",
    ),
  sourceLineStart: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Starting line number to copy (1-indexed, inclusive). " +
        "Must be used together with sourceLineEnd.",
    ),
  sourceLineEnd: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Ending line number to copy (1-indexed, inclusive). " +
        "Must be used together with sourceLineStart.",
    ),
  destFile: z
    .string()
    .min(1)
    .describe("The file to copy to (absolute or relative path)"),
  destAnchor: z
  .string()
  .min(0)  // было min(1)
  .describe("The exact text in destFile where insertion will occur"),
  insert: z
    .enum(["before", "after", "replace"])
    .describe("Insertion position relative to destAnchor"),
  validate: z
    .boolean()
    .optional()
    .describe(
      "Re-validate that the source hasn't changed before writing. Defaults to true.",
    ),
})

type Parameters = z.infer<typeof Parameters>
type InsertMode = Parameters["insert"]

// ─────────────────────────────────────────────
// Line-ending utilities
// ─────────────────────────────────────────────

type LineEnding = "\n" | "\r\n"

function detectLineEnding(text: string): LineEnding {
  return text.includes("\r\n") ? "\r\n" : "\n"
}

function toUnix(text: string): string {
  return text.replaceAll("\r\n", "\n")
}

function applyLineEnding(text: string, ending: LineEnding): string {
  const unix = toUnix(text)
  return ending === "\r\n" ? unix.replaceAll("\n", "\r\n") : unix
}

// ─────────────────────────────────────────────
// Source extraction
// ─────────────────────────────────────────────

interface SourceExtractionResult {
  readonly content: string
  readonly lineStart: number
  readonly lineEnd: number
}

function extractSourceContent(
  rawContent: string,
  sourceString: string | undefined,
  sourceLineStart: number | undefined,
  sourceLineEnd: number | undefined,
): SourceExtractionResult | CopyToolError | null {
  const unixContent = toUnix(rawContent)
  const lines = unixContent.split("\n")

  // Branch A: explicit line range
  if (sourceLineStart !== undefined && sourceLineEnd !== undefined) {
    if (sourceLineStart > sourceLineEnd) {
      return new CopyToolError({
        reason: "InvalidLineRange",
        message:
          `sourceLineStart (${sourceLineStart}) must not exceed ` +
          `sourceLineEnd (${sourceLineEnd}).`,
      })
    }
    if (sourceLineEnd > lines.length) {
      return new CopyToolError({
        reason: "InvalidLineRange",
        message:
          `Line range ${sourceLineStart}–${sourceLineEnd} exceeds ` +
          `file length (${lines.length} lines).`,
      })
    }
    return {
      content: lines.slice(sourceLineStart - 1, sourceLineEnd).join("\n"),
      lineStart: sourceLineStart,
      lineEnd: sourceLineEnd,
    }
  }

  // Branch B: substring match
  if (sourceString !== undefined) {
    const normalizedSearch = toUnix(sourceString)
    const idx = unixContent.indexOf(normalizedSearch)
    if (idx === -1) return null

    const before = unixContent.slice(0, idx)
    const lineStart = before.split("\n").length
    const lineEnd = lineStart + normalizedSearch.split("\n").length - 1

    return { content: normalizedSearch, lineStart, lineEnd }
  }

  return null
}

// ─────────────────────────────────────────────
// Destination anchor resolution
// ─────────────────────────────────────────────

interface AnchorResolutionResult {
  readonly before: string
  readonly anchor: string
  readonly after: string
}

function normalizeWhitespace(s: string): string {
  return s.replace(/[^\S\n]+/g, " ").trimEnd()
}

function resolveDestAnchor(
  rawDestContent: string,
  destAnchor: string,
): AnchorResolutionResult | null {
  const normalizedContent = toUnix(rawDestContent)
  const normalizedAnchor = toUnix(destAnchor)

  const makeResult = (before: string, anchor: string, after: string): AnchorResolutionResult => ({
    before: before.endsWith("\n") ? before.slice(0, -1) : before,
    anchor,
    after: after.startsWith("\n") ? after.slice(1) : after,
  })

  // Exact match
  const idx = normalizedContent.indexOf(normalizedAnchor)
  if (idx !== -1) {
    return makeResult(
      normalizedContent.slice(0, idx),
      normalizedAnchor,
      normalizedContent.slice(idx + normalizedAnchor.length),
    )
  }

  // Fuzzy match
  const anchorLines = normalizedAnchor.split("\n")
  const contentLines = normalizedContent.split("\n")
  for (let i = 0; i <= contentLines.length - anchorLines.length; i++) {
    let match = true
    for (let j = 0; j < anchorLines.length; j++) {
      if (normalizeWhitespace(contentLines[i + j]) !== normalizeWhitespace(anchorLines[j])) {
        match = false
        break
      }
    }
    if (match) {
      return makeResult(
        contentLines.slice(0, i).join("\n"),
        contentLines.slice(i, i + anchorLines.length).join("\n"),
        contentLines.slice(i + anchorLines.length).join("\n"),
      )
    }
  }

  return null
}

function countAnchorOccurrences(content: string, anchor: string): number {
  if (anchor.length === 0) return 0
  let count = 0
  let pos = 0
  while ((pos = content.indexOf(anchor, pos)) !== -1) {
    count++
    pos += anchor.length
  }
  return count
}

// ─────────────────────────────────────────────
// Content assembly
// ─────────────────────────────────────────────

function assembleDestContent(
  parts: AnchorResolutionResult,
  sourceContent: string,
  insert: InsertMode,
): string {
  const { before, anchor, after } = parts

  // sep: соединяет два сегмента ровно одним \n если оба непустые
  const sep = (a: string, b: string): string => {
    if (a.length === 0) return b
    if (b.length === 0) return a
    return a + "\n" + b
  }

  switch (insert) {
    case "before": {
      // before \n source \n anchor + \n + after (after уже содержит внутренние \n)
      const tail = after.length > 0 ? anchor + "\n" + after : anchor
      return sep(sep(before, sourceContent), tail)
    }
    case "after": {
      // before + \n + anchor \n source \n after
      const head = before.length > 0 ? before + "\n" + anchor : anchor
      return sep(head, sep(sourceContent, after))
    }
    case "replace": {
      // before + source + \n + after (если after непустой)
      return after.length > 0 ? before + sourceContent + "\n" + after : before + sourceContent + after
    }
    default: {
      const _never: never = insert
      throw new Error(`Unhandled insert mode: ${_never}`)
    }
  }
}

// ─────────────────────────────────────────────
// Parameter validation
// ─────────────────────────────────────────────

function validateParameters(
  params: Parameters,
): Effect.Effect<void, CopyToolError> {
  return Effect.gen(function* () {
    if (!params.sourceString && params.sourceLineStart === undefined) {
      throw new CopyToolError({
        reason: "InvalidParameters",
        message:
          "Must provide either sourceString or both sourceLineStart and sourceLineEnd.",
      })
    }
    if (
      (params.sourceLineStart === undefined) !==
      (params.sourceLineEnd === undefined)
    ) {
      throw new CopyToolError({
        reason: "InvalidParameters",
        message:
          "sourceLineStart and sourceLineEnd must both be provided or both omitted.",
      })
    }
  })
}

// ─────────────────────────────────────────────
// Path resolution
// ─────────────────────────────────────────────

function resolvePath(filePath: string): string {
  return path.isAbsolute(filePath)
    ? filePath
    : path.join(Instance.directory, filePath)
}

// ─────────────────────────────────────────────
// CopyTool
// ─────────────────────────────────────────────

export const CopyTool = Tool.define(
  "copy",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* AppFileSystem.Service
    const format = yield* Format.Service
    const bus = yield* Bus.Service

    // Capture semaphore factory in closure — no R leakage into execute
    const lock = (p: string) => getLock(p)

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Parameters, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // ── 1. Validate ─────────────────────────────────────────
          yield* validateParameters(params)

          // ── 2. Resolve paths ────────────────────────────────────
          const sourceFile = resolvePath(params.sourceFile)
          const destFile = resolvePath(params.destFile)

          yield* assertExternalDirectoryEffect(ctx, sourceFile)
          yield* assertExternalDirectoryEffect(ctx, destFile)

          // ── 3. Acquire locks ────────────────────────────────────
          yield* lock(sourceFile).withPermits(1)(Effect.void)
          yield* lock(destFile).withPermits(1)(Effect.void)

          // ── 4. Source file checks ───────────────────────────────
          const sourceExists = yield* afs.existsSafe(sourceFile)
          if (!sourceExists) {
            throw new CopyToolError({
              reason: "SourceNotFound",
              message: `Source file not found: ${sourceFile}`,
            })
          }

          const sourceStat = yield* afs
            .stat(sourceFile)
            .pipe(Effect.catch(() => Effect.succeed(undefined)))

          if (sourceStat?.type === "Directory") {
            throw new CopyToolError({
              reason: "SourceIsDirectory",
              message: `Source path is a directory, not a file: ${sourceFile}`,
            })
          }

          // ── 5. Destination file checks ──────────────────────────
          const destExists = yield* afs.existsSafe(destFile)
          if (!destExists) {
            yield* afs.writeWithDirs(destFile, "")
          } else {
            const destStat = yield* afs
              .stat(destFile)
              .pipe(Effect.catch(() => Effect.succeed(undefined)))

            if (destStat?.type === "Directory") {
              throw new CopyToolError({
                reason: "DestIsDirectory",
                message: `Destination path is a directory, not a file: ${destFile}`,
              })
            }
          }

          // ── 6. Read contents ────────────────────────────────────
          const sourceRaw = yield* afs.readFileString(sourceFile)
          const destRaw = yield* afs.readFileString(destFile)
          const destEnding = detectLineEnding(destRaw)

          // ── 7. Extract source content ───────────────────────────
          const sourceResult = extractSourceContent(
            sourceRaw,
            params.sourceString,
            params.sourceLineStart,
            params.sourceLineEnd,
          )

          if (sourceResult instanceof CopyToolError) {
            throw sourceResult
          }
          if (sourceResult === null) {
            throw new CopyToolError({
              reason: "SourceContentNotFound",
              message: params.sourceString
                ? `Could not find source content in ${sourceFile}.`
                : `Could not extract content from ${sourceFile}. ` +
                  `Provide either sourceString or sourceLineStart/sourceLineEnd.`,
            })
          }

          const { content: sourceContent, lineStart, lineEnd } = sourceResult

          // ── 8. Validate source unchanged ────────────────────────
          if (params.validate !== false) {
            const sourceReread = yield* afs.readFileString(sourceFile)
            if (sourceReread !== sourceRaw) {
              const revalidated = extractSourceContent(
                sourceReread,
                params.sourceString,
                params.sourceLineStart,
                params.sourceLineEnd,
              )
              const contentChanged =
                revalidated === null ||
                revalidated instanceof CopyToolError ||
                revalidated.content !== sourceContent

              if (contentChanged) {
                throw new CopyToolError({
                  reason: "SourceChangedDuringOperation",
                  message:
                    "Source file changed during the operation. " +
                    "Please retry with the updated source content.",
                })
              }
            }
          }

          // ── 9. Resolve anchor ───────────────────────────────────
          const anchorResult = resolveDestAnchor(destRaw, params.destAnchor)
          if (anchorResult === null) {
            throw new CopyToolError({
              reason: "AnchorNotFound",
              message:
                `Could not find destAnchor in ${destFile}. ` +
                `Ensure the anchor text matches exactly including whitespace.`,
            })
          }

          const anchorCount = countAnchorOccurrences(
            toUnix(destRaw),
            toUnix(params.destAnchor),
          )

          // ── 10. Assemble ────────────────────────────────────────
          const assembledUnix = assembleDestContent(
            anchorResult,
            sourceContent,
            params.insert,
          )
          const newDestContent = applyLineEnding(assembledUnix, destEnding)

          // ── 11. Diff ────────────────────────────────────────────
          const diff = trimDiff(
            createTwoFilesPatch(
              destFile,
              destFile,
              toUnix(destRaw),
              toUnix(newDestContent),
            ),
          )

          const sourceRelative = path.relative(Instance.worktree, sourceFile)
          const destRelative = path.relative(Instance.worktree, destFile)

          // ── 12. Request permission ──────────────────────────────
          yield* ctx.ask({
            permission: "edit",
            patterns: [sourceRelative, destRelative],
            always: ["*"],
            metadata: { action: "copy", sourceFile, destFile, diff },
          })

          // ── 13. Write & notify ──────────────────────────────────
          yield* afs.writeWithDirs(destFile, newDestContent)
          yield* format.file(destFile)
          yield* bus.publish(File.Event.Edited, { file: destFile })
          yield* bus.publish(FileWatcher.Event.Updated, {
            file: destFile,
            event: destExists ? "change" : "add",
          })

          // ── 14. Diff statistics ─────────────────────────────────
          let additions = 0
          let deletions = 0
          for (const change of diffLines(
            toUnix(destRaw),
            toUnix(newDestContent),
          )) {
            if (change.added) additions += change.count ?? 0
            if (change.removed) deletions += change.count ?? 0
          }

          const filediff = { file: destFile, patch: diff, additions, deletions }

          yield* ctx.metadata({ metadata: { diff, filediff } })
          yield* lsp.touchFile(destFile, true)

          // ── 15. Result ──────────────────────────────────────────
          const lines = sourceContent.split("\n").length
          const insertDesc =
            params.insert === "replace"
              ? "replaced"
              : params.insert === "before"
                ? "inserted before"
                : "inserted after"

          const ambiguityWarning =
            anchorCount > 1
              ? ` Warning: destAnchor matched ${anchorCount} times — used first occurrence.`
              : ""

          const output =
            `Copied ${lines} line${lines !== 1 ? "s" : ""} from ` +
            `${sourceRelative} (lines ${lineStart}-${lineEnd}) to ` +
            `${destRelative}, ${insertDesc} anchor.${ambiguityWarning}`

          return {
            metadata: {
              sourceFile,
              sourceLineStart: lineStart,
              sourceLineEnd: lineEnd,
              destFile,
              insert: params.insert,
              lines,
              filediff,
            },
            title: destRelative,
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)