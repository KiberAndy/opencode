import { afterAll, afterEach, describe, test, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Layer, ManagedRuntime } from "effect"
import { CopyTool } from "../../src/tool/copy"
import { tmpdir, disposeAllInstances, provideInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { InstanceRef } from "../../src/effect/instance-ref"
import { LSP } from "../../src/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Truncate } from "../../src/tool/truncate"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionID, MessageID } from "../../src/session/schema"
import type * as Copy from "../../src/tool/copy"

type CopyParams = {
  sourceFile: string
  sourceString?: string
  sourceLineStart?: number
  sourceLineEnd?: number
  destFile: string
  destAnchor: string
  insert: "before" | "after" | "replace"
  validate?: boolean
}

// ---------------------------------------------------------------------------
// Shared context & runtime
// ---------------------------------------------------------------------------

const ctx = {
  sessionID: SessionID.make("ses_test-copy-session"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build" as const,
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    LSP.defaultLayer,
    FSUtil.defaultLayer,
    Format.defaultLayer,
    EventV2Bridge.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
  ),
)

afterAll(async () => {
  await runtime.dispose()
})

const storeLayer = Layer.mergeAll(
  testInstanceStoreLayer,
  CrossSpawnSpawner.defaultLayer,
)

function runInInstance<A>(dir: string, effect: Effect.Effect<A, never, never>) {
  return Effect.runPromise(
    provideInstance(dir)(effect).pipe(
      Effect.provide(storeLayer),
    ),
  )
}

/** Execute copy inside an Instance context. Returns the execute result. */
function runCopyEffect(dir: string, params: CopyParams) {
  return Effect.gen(function* () {
    const info = yield* CopyTool
    const copy = yield* info.init()
    return yield* copy.execute(params, ctx as any)
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        LSP.defaultLayer,
        FSUtil.defaultLayer,
        Format.defaultLayer,
        EventV2Bridge.defaultLayer,
        Truncate.defaultLayer,
        Agent.defaultLayer,
      ),
    ),
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run copy.execute inside an Instance context. Returns { result, content }. */
async function runCopy(
  tmp: { path: string },
  params: CopyParams,
) {
  return runInInstance(
    tmp.path,
    Effect.gen(function* () {
      const info = yield* CopyTool
      const copy = yield* info.init()
      const result = yield* copy.execute(params, ctx as any)
      if (params.destFile) {
        const abs = path.isAbsolute(params.destFile)
          ? params.destFile
          : path.join(tmp.path, params.destFile)
        const content = yield* Effect.promise(() => fs.readFile(abs, "utf-8"))
        return { result, content }
      }
      return { result, content: "" as const }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          LSP.defaultLayer,
          FSUtil.defaultLayer,
          Format.defaultLayer,
          EventV2Bridge.defaultLayer,
          Truncate.defaultLayer,
          Agent.defaultLayer,
        ),
      ),
    ),
  )
}

/** Returns raw bytes (Buffer) of a file — for binary/line-ending assertions. */
async function readBytes(filepath: string): Promise<Buffer> {
  return fs.readFile(filepath)
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("tool.copy", () => {
  // =========================================================================
  // INSERT BEFORE
  // =========================================================================
  describe("insert before", () => {
    test("basic: copies text and inserts before anchor", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "source.ts")
      const dst = path.join(tmp.path, "dest.ts")

      await fs.writeFile(src, "export function helper() {\n  return 42;\n}")
      await fs.writeFile(dst, "export function main() {\n  console.log('hello');\n}")

      const { result, content } = await runCopy(tmp, {
        sourceFile: src,
        sourceString: "export function helper() {\n  return 42;\n}",
        destFile: dst,
        destAnchor: "export function main()",
        insert: "before",
      })

      expect(content).toContain("export function helper()")
      expect(content).toContain("export function main()")
      // helper MUST appear before main
      expect(content.indexOf("helper")).toBeLessThan(content.indexOf("main"))
      expect(result.output).toContain("Copied 3 lines")
      expect(result.output).toContain("inserted before")
    })

    test("line range: picks exact slice", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "source.ts")
      const dst = path.join(tmp.path, "dest.ts")

      await fs.writeFile(src, "line1\nline2\nline3\nline4\nline5")
      await fs.writeFile(dst, "start\nend")

      const { content, result } = await runCopy(tmp, {
        sourceFile: src,
        sourceLineStart: 2,
        sourceLineEnd: 3,
        destFile: dst,
        destAnchor: "start",
        insert: "before",
      })

      expect(content).toBe("line2\nline3\nstart\nend")
      expect(result.output).toContain("lines 2-3")
    })

    test("inserts before the FIRST line of file", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "s.txt")
      const dst = path.join(tmp.path, "d.txt")

      await fs.writeFile(src, "HEADER")
      await fs.writeFile(dst, "FIRST\nSECOND")

      const { content } = await runCopy(tmp, {
        sourceFile: src,
        sourceString: "HEADER",
        destFile: dst,
        destAnchor: "FIRST",
        insert: "before",
      })

      expect(content.startsWith("HEADER")).toBe(true)
    })

    test("inserts before the LAST line of file", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "s.txt")
      const dst = path.join(tmp.path, "d.txt")

      await fs.writeFile(src, "INJECTED")
      await fs.writeFile(dst, "ALPHA\nBETA\nGAMMA")

      const { content } = await runCopy(tmp, {
        sourceFile: src,
        sourceString: "INJECTED",
        destFile: dst,
        destAnchor: "GAMMA",
        insert: "before",
      })

      expect(content).toBe("ALPHA\nBETA\nINJECTED\nGAMMA")
    })

    test("single-line destination file", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "s.txt")
      const dst = path.join(tmp.path, "d.txt")

      await fs.writeFile(src, "PREFIX")
      await fs.writeFile(dst, "ONLY")

      const { content } = await runCopy(tmp, {
        sourceFile: src,
        sourceString: "PREFIX",
        destFile: dst,
        destAnchor: "ONLY",
        insert: "before",
      })

      expect(content).toContain("PREFIX")
      expect(content).toContain("ONLY")
    })

    test("anchor is a blank line", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "s.txt")
      const dst = path.join(tmp.path, "d.txt")

      await fs.writeFile(src, "INSERTED")
      // dest has an empty line in the middle
      await fs.writeFile(dst, "A\n\nB")

      const { content } = await runCopy(tmp, {
        sourceFile: src,
        sourceString: "INSERTED",
        destFile: dst,
        destAnchor: "",
        insert: "before",
      })

      expect(content).toContain("INSERTED")
    })

    test("idempotency: calling twice doubles insertion", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "s.txt")
      const dst = path.join(tmp.path, "d.txt")

      await fs.writeFile(src, "X")
      await fs.writeFile(dst, "Y")

      await runCopy(tmp, { sourceFile: src, sourceString: "X", destFile: dst, destAnchor: "Y", insert: "before" })
      const { content } = await runCopy(tmp, { sourceFile: src, sourceString: "X", destFile: dst, destAnchor: "Y", insert: "before" })

      // Should have two occurrences of X after double insert
      const matches = content.match(/X/g) ?? []
      expect(matches.length).toBeGreaterThanOrEqual(2)
    })
  })

  // =========================================================================
  // INSERT AFTER
  // =========================================================================
  describe("insert after", () => {
    test("basic: copies text and inserts after anchor", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "source.ts")
      const dst = path.join(tmp.path, "dest.ts")

      await fs.writeFile(src, "// Helper function\nfunction help() {}\n")
      await fs.writeFile(dst, "// Entry point\nexport const app = true;")

      const { result, content } = await runCopy(tmp, {
        sourceFile: src,
        sourceString: "// Helper function\nfunction help() {}",
        destFile: dst,
        destAnchor: "// Entry point",
        insert: "after",
      })

      expect(content).toContain("// Entry point")
      expect(content).toContain("// Helper function")
      expect(content).toContain("function help()")
      // entry point MUST appear before helper
      expect(content.indexOf("Entry point")).toBeLessThan(content.indexOf("Helper function"))
      expect(result.output).toContain("inserted after")
    })

    test("inserts after the LAST line of file", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "s.txt")
      const dst = path.join(tmp.path, "d.txt")

      await fs.writeFile(src, "TAIL")
      await fs.writeFile(dst, "A\nB\nC")

      const { content } = await runCopy(tmp, {
        sourceFile: src,
        sourceString: "TAIL",
        destFile: dst,
        destAnchor: "C",
        insert: "after",
      })

      expect(content.endsWith("TAIL") || content.endsWith("TAIL\n")).toBe(true)
    })

    test("inserts after the FIRST line of file", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "s.txt")
      const dst = path.join(tmp.path, "d.txt")

      await fs.writeFile(src, "BETWEEN")
      await fs.writeFile(dst, "TOP\nBOTTOM")

      const { content } = await runCopy(tmp, {
        sourceFile: src,
        sourceString: "BETWEEN",
        destFile: dst,
        destAnchor: "TOP",
        insert: "after",
      })

      expect(content).toBe("TOP\nBETWEEN\nBOTTOM")
    })
  })

  // =========================================================================
  // REPLACE
  // =========================================================================
  describe("replace", () => {
    test("basic: replaces single-line anchor", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "source.ts")
      const dst = path.join(tmp.path, "dest.ts")

      await fs.writeFile(src, "NEW_IMPORT")
      await fs.writeFile(dst, "OLD_IMPORT")

      const { result, content } = await runCopy(tmp, {
        sourceFile: src,
        sourceString: "NEW_IMPORT",
        destFile: dst,
        destAnchor: "OLD_IMPORT",
        insert: "replace",
      })

      expect(content).toBe("NEW_IMPORT")
      expect(result.output).toContain("replaced")
    })

    test("replaces multi-line block", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "source.ts")
      const dst = path.join(tmp.path, "dest.ts")

      await fs.writeFile(src, "export const newConfig = {\n  name: 'test',\n  version: 1,\n};")
      await fs.writeFile(dst, "export const oldConfig = {\n  name: 'old',\n  version: 0,\n};")

      const { result, content } = await runCopy(tmp, {
        sourceFile: src,
        sourceString: "export const newConfig = {\n  name: 'test',\n  version: 1,\n};",
        destFile: dst,
        destAnchor: "export const oldConfig = {\n  name: 'old',\n  version: 0,\n};",
        insert: "replace",
      })

      expect(content).toContain("newConfig")
      expect(content).not.toContain("oldConfig")
      expect(result.output).toContain("replaced")
    })

    test("replace leaves surrounding lines intact", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "s.txt")
      const dst = path.join(tmp.path, "d.txt")

      await fs.writeFile(src, "MIDDLE_NEW")
      await fs.writeFile(dst, "BEFORE\nMIDDLE_OLD\nAFTER")

      const { content } = await runCopy(tmp, {
        sourceFile: src,
        sourceString: "MIDDLE_NEW",
        destFile: dst,
        destAnchor: "MIDDLE_OLD",
        insert: "replace",
      })

      expect(content).toContain("BEFORE")
      expect(content).toContain("MIDDLE_NEW")
      expect(content).toContain("AFTER")
      expect(content).not.toContain("MIDDLE_OLD")
    })

    test("replace entire single-line file", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "s.txt")
      const dst = path.join(tmp.path, "d.txt")

      await fs.writeFile(src, "REPLACEMENT")
      await fs.writeFile(dst, "ORIGINAL")

      const { content } = await runCopy(tmp, {
        sourceFile: src,
        sourceString: "REPLACEMENT",
        destFile: dst,
        destAnchor: "ORIGINAL",
        insert: "replace",
      })

      expect(content).toBe("REPLACEMENT")
    })
  })

  // =========================================================================
  // SOURCE LINE RANGE — EDGE CASES
  // =========================================================================
  describe("sourceLineStart / sourceLineEnd edge cases", () => {
    test("single line extraction (start === end)", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "s.txt")
      const dst = path.join(tmp.path, "d.txt")

      await fs.writeFile(src, "A\nB\nC\nD")
      await fs.writeFile(dst, "anchor")

      const { content } = await runCopy(tmp, {
        sourceFile: src,
        sourceLineStart: 3,
        sourceLineEnd: 3,
        destFile: dst,
        destAnchor: "anchor",
        insert: "after",
      })

      expect(content).toContain("C")
      expect(content).not.toContain("A")
      expect(content).not.toContain("B")
      expect(content).not.toContain("D")
    })

    test("first line only (start=1, end=1)", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "s.txt")
      const dst = path.join(tmp.path, "d.txt")

      await fs.writeFile(src, "FIRST\nSECOND\nTHIRD")
      await fs.writeFile(dst, "anchor")

      const { content } = await runCopy(tmp, {
        sourceFile: src,
        sourceLineStart: 1,
        sourceLineEnd: 1,
        destFile: dst,
        destAnchor: "anchor",
        insert: "before",
      })

      expect(content).toContain("FIRST")
      expect(content).not.toContain("SECOND")
    })

    test("last line only", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "s.txt")
      const dst = path.join(tmp.path, "d.txt")

      await fs.writeFile(src, "A\nB\nLAST")
      await fs.writeFile(dst, "X")

      const { content } = await runCopy(tmp, {
        sourceFile: src,
        sourceLineStart: 3,
        sourceLineEnd: 3,
        destFile: dst,
        destAnchor: "X",
        insert: "after",
      })

      expect(content).toContain("LAST")
      expect(content).toBe("X\nLAST")
      expect(content).not.toContain("A\n")
      expect(content).not.toContain("\nB\n")
    })

    test("out-of-range lineEnd throws descriptive error", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "s.txt")
      const dst = path.join(tmp.path, "d.txt")

      await fs.writeFile(src, "A\nB")
      await fs.writeFile(dst, "anchor")

      await expect(
        runInInstance(
          tmp.path,
          runCopyEffect(tmp.path, {
            sourceFile: src,
            sourceLineStart: 1,
            sourceLineEnd: 999,
            destFile: dst,
            destAnchor: "anchor",
            insert: "after",
          }),
        ),
      ).rejects.toThrow(/lineEnd|range|bounds/i)
    })

    test("reversed range (start > end) throws descriptive error", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "s.txt")
      const dst = path.join(tmp.path, "d.txt")

      await fs.writeFile(src, "A\nB\nC")
      await fs.writeFile(dst, "anchor")

      await expect(
        Effect.runPromise(
          provideInstance(tmp.path)(
            runCopyEffect(tmp.path, {
              sourceFile: src,
              sourceLineStart: 3,
              sourceLineEnd: 1,
              destFile: dst,
              destAnchor: "anchor",
              insert: "before",
            }),
          ).pipe(Effect.provide(storeLayer)),
        ),
      ).rejects.toThrow()
    })
  })

  // =========================================================================
  // ERROR HANDLING
  // =========================================================================
  describe("error handling", () => {
    test("source file not found", async () => {
      await using tmp = await tmpdir()
      const dst = path.join(tmp.path, "dest.ts")
      await fs.writeFile(dst, "content")

      await expect(
        runInInstance(
          tmp.path,
          runCopyEffect(tmp.path, {
            sourceFile: path.join(tmp.path, "nonexistent.ts"),
              sourceString: "something",
              destFile: dst,
              destAnchor: "content",
              insert: "before",
            }),
          ),
      ).rejects.toThrow("Source file not found")
    })

    test("dest anchor not found", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "source.ts")
      const dst = path.join(tmp.path, "dest.ts")

      await fs.writeFile(src, "content")
      await fs.writeFile(dst, "original content")

      await expect(
        Effect.runPromise(
          provideInstance(tmp.path)(
            runCopyEffect(tmp.path, {
              sourceFile: src,
              sourceString: "content",
              destFile: dst,
              destAnchor: "nonexistent anchor",
              insert: "before",
            }),
          ).pipe(Effect.provide(storeLayer)),
        ),
      ).rejects.toThrow("Could not find destAnchor")
    })

    test("source string not found in source file", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "source.ts")
      const dst = path.join(tmp.path, "dest.ts")

      await fs.writeFile(src, "some content here")
      await fs.writeFile(dst, "target content")

      await expect(
        Effect.runPromise(
          provideInstance(tmp.path)(
            runCopyEffect(tmp.path, {
              sourceFile: src,
              sourceString: "nonexistent string",
              destFile: dst,
              destAnchor: "target content",
              insert: "before",
            }),
          ).pipe(Effect.provide(storeLayer)),
        ),
      ).rejects.toThrow("Could not find source content")
    })

    test("dest file not found throws", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "source.ts")

      await fs.writeFile(src, "content")

      await expect(
        Effect.runPromise(
          provideInstance(tmp.path)(
            runCopyEffect(tmp.path, {
              sourceFile: src,
              sourceString: "content",
              destFile: path.join(tmp.path, "nonexistent_dest.ts"),
              destAnchor: "anchor",
              insert: "before",
            }),
          ).pipe(Effect.provide(storeLayer)),
        ),
      ).rejects.toThrow()
    })

    test("empty source file throws", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "empty.ts")
      const dst = path.join(tmp.path, "dest.ts")

      await fs.writeFile(src, "")
      await fs.writeFile(dst, "anchor")

      await expect(
        Effect.runPromise(
          provideInstance(tmp.path)(
            runCopyEffect(tmp.path, {
              sourceFile: src,
              sourceString: "anything",
              destFile: dst,
              destAnchor: "anchor",
              insert: "before",
            }),
          ).pipe(Effect.provide(storeLayer)),
        ),
      ).rejects.toThrow()
    })

    test("empty dest file throws on anchor not found", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "s.ts")
      const dst = path.join(tmp.path, "empty_dest.ts")

      await fs.writeFile(src, "content")
      await fs.writeFile(dst, "")

      await expect(
        Effect.runPromise(
          provideInstance(tmp.path)(
            runCopyEffect(tmp.path, {
              sourceFile: src,
              sourceString: "content",
              destFile: dst,
              destAnchor: "missing",
              insert: "before",
            }),
          ).pipe(Effect.provide(storeLayer)),
        ),
      ).rejects.toThrow()
    })

    test("error does NOT mutate dest file", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "s.ts")
      const dst = path.join(tmp.path, "d.ts")
      const originalContent = "untouched content"

      await fs.writeFile(src, "something")
      await fs.writeFile(dst, originalContent)

      await expect(
        Effect.runPromise(
          provideInstance(tmp.path)(
            runCopyEffect(tmp.path, {
              sourceFile: src,
              sourceString: "something",
              destFile: dst,
              destAnchor: "ANCHOR_THAT_DOES_NOT_EXIST",
              insert: "replace",
            }),
          ).pipe(Effect.provide(storeLayer)),
        ),
      ).rejects.toThrow(/Could not find destAnchor/i)

      const content = await fs.readFile(dst, "utf-8")
      expect(content).toBe(originalContent)
    })
  })

  // =========================================================================
  // RELATIVE PATHS
  // =========================================================================
  describe("relative paths", () => {
    test("both files relative", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "source.txt")
      const dst = path.join(tmp.path, "dest.txt")

      await fs.writeFile(src, "Hello from source")
      await fs.writeFile(dst, "Start\nEnd")

      const { content } = await runCopy(tmp, {
        sourceFile: "source.txt",
        sourceString: "Hello from source",
        destFile: "dest.txt",
        destAnchor: "Start",
        insert: "before",
      })

      expect(content).toBe("Hello from source\nStart\nEnd")
    })

    test("source absolute, dest relative", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "source.txt")
      const dst = path.join(tmp.path, "dest.txt")

      await fs.writeFile(src, "ABS_SRC")
      await fs.writeFile(dst, "anchor")

      const { content } = await runCopy(tmp, {
        sourceFile: src, // absolute
        sourceString: "ABS_SRC",
        destFile: "dest.txt", // relative
        destAnchor: "anchor",
        insert: "after",
      })

      expect(content).toContain("ABS_SRC")
    })

    test("source relative, dest absolute", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "source.txt")
      const dst = path.join(tmp.path, "dest.txt")

      await fs.writeFile(src, "REL_SRC")
      await fs.writeFile(dst, "anchor")

      const { content } = await runCopy(tmp, {
        sourceFile: "source.txt", // relative
        sourceString: "REL_SRC",
        destFile: dst, // absolute
        destAnchor: "anchor",
        insert: "after",
      })

      expect(content).toContain("REL_SRC")
    })
  })

  // =========================================================================
  // LINE ENDINGS
  // =========================================================================
  describe("line endings", () => {
    test("CRLF dest: inserted content uses CRLF", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "source.txt")
      const dst = path.join(tmp.path, "dest.txt")

      await fs.writeFile(src, "line1\nline2")
      await fs.writeFile(dst, "header\r\nfooter")

      await runCopy(tmp, {
        sourceFile: src,
        sourceString: "line1\nline2",
        destFile: dst,
        destAnchor: "header",
        insert: "after",
      })

      const bytes = await readBytes(dst)
      expect(bytes.toString()).toContain("\r\n")
    })

    test("LF dest: no CRLF introduced", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "s.txt")
      const dst = path.join(tmp.path, "d.txt")

      await fs.writeFile(src, "INSERT")
      // write LF-only explicitly
      await fs.writeFile(dst, Buffer.from("A\nB\nC", "utf-8"))

      await runCopy(tmp, {
        sourceFile: src,
        sourceString: "INSERT",
        destFile: dst,
        destAnchor: "A",
        insert: "after",
      })

      const bytes = await readBytes(dst)
      expect(bytes.toString()).not.toContain("\r\n")
    })

    test("mixed CRLF/LF source: dest line endings preserved", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "s.txt")
      const dst = path.join(tmp.path, "d.txt")

      // source has mixed endings
      await fs.writeFile(src, Buffer.from("mixed\r\nline\nhere", "utf-8"))
      await fs.writeFile(dst, Buffer.from("anchor\r\nend", "utf-8"))

      await runCopy(tmp, {
        sourceFile: src,
        sourceString: "mixed\r\nline\nhere",
        destFile: dst,
        destAnchor: "anchor",
        insert: "before",
      })

      const bytes = await readBytes(dst)
      // dest had CRLF — should still have CRLF somewhere
      expect(bytes.toString()).toContain("\r\n")
    })
  })

  // =========================================================================
  // UNICODE & SPECIAL CHARACTERS
  // =========================================================================
  describe("unicode and special characters", () => {
    test("CJK characters in content", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "s.ts")
      const dst = path.join(tmp.path, "d.ts")

      await fs.writeFile(src, "const greeting = '你好世界';", "utf-8")
      await fs.writeFile(dst, "// TODO: add greeting\nexport {};\n", "utf-8")

      const { content } = await runCopy(tmp, {
        sourceFile: src,
        sourceString: "const greeting = '你好世界';",
        destFile: dst,
        destAnchor: "// TODO: add greeting",
        insert: "before",
      })

      expect(content).toContain("你好世界")
    })

    test("emoji in content", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "s.txt")
      const dst = path.join(tmp.path, "d.txt")

      await fs.writeFile(src, "// 🚀 launch", "utf-8")
      await fs.writeFile(dst, "// placeholder", "utf-8")

      const { content } = await runCopy(tmp, {
        sourceFile: src,
        sourceString: "// 🚀 launch",
        destFile: dst,
        destAnchor: "// placeholder",
        insert: "replace",
      })

      expect(content).toContain("🚀")
    })

    test("tab indentation preserved", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "s.ts")
      const dst = path.join(tmp.path, "d.ts")

      await fs.writeFile(src, "function foo() {\n\treturn 1;\n}")
      await fs.writeFile(dst, "// anchor\n")

      const { content } = await runCopy(tmp, {
        sourceFile: src,
        sourceString: "function foo() {\n\treturn 1;\n}",
        destFile: dst,
        destAnchor: "// anchor",
        insert: "after",
      })

      expect(content).toContain("\t")
    })

    test("trailing whitespace in source preserved", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "s.txt")
      const dst = path.join(tmp.path, "d.txt")

      await fs.writeFile(src, "trailing   ")
      await fs.writeFile(dst, "anchor")

      const { content } = await runCopy(tmp, {
        sourceFile: src,
        sourceString: "trailing   ",
        destFile: dst,
        destAnchor: "anchor",
        insert: "after",
      })

      expect(content).toContain("trailing   ")
    })

    test("very long line (>10k chars)", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "s.txt")
      const dst = path.join(tmp.path, "d.txt")
      const longLine = "x".repeat(10_000)

      await fs.writeFile(src, longLine)
      await fs.writeFile(dst, "anchor\nend")

      const { content } = await runCopy(tmp, {
        sourceFile: src,
        sourceString: longLine,
        destFile: dst,
        destAnchor: "anchor",
        insert: "after",
      })

      expect(content).toContain(longLine)
    })
  })

  // =========================================================================
  // LARGE FILES
  // =========================================================================
  describe("large files", () => {
    test("1000-line source and dest — performance sanity (<5s)", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "big_src.ts")
      const dst = path.join(tmp.path, "big_dst.ts")

      const srcLines = Array.from({ length: 1000 }, (_, i) => `// src line ${i + 1}`).join("\n")
      const dstLines = Array.from({ length: 1000 }, (_, i) => `// dst line ${i + 1}`).join("\n")

      await fs.writeFile(src, srcLines)
      await fs.writeFile(dst, dstLines)

      const start = Date.now()

      const { content } = await runCopy(tmp, {
        sourceFile: src,
        sourceString: "// src line 500",
        destFile: dst,
        destAnchor: "// dst line 500",
        insert: "before",
      })

      const elapsed = Date.now() - start
      expect(elapsed).toBeLessThan(5000)
      expect(content).toContain("// src line 500")
      expect(content).toContain("// dst line 500")
    })
  })

  // =========================================================================
  // OUTPUT MESSAGE QUALITY
  // =========================================================================
  describe("output message quality", () => {
    test("output reports correct line count for multi-line source", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "s.ts")
      const dst = path.join(tmp.path, "d.ts")

      await fs.writeFile(src, "a\nb\nc\nd\ne")
      await fs.writeFile(dst, "anchor")

      const { result } = await runCopy(tmp, {
        sourceFile: src,
        sourceLineStart: 1,
        sourceLineEnd: 5,
        destFile: dst,
        destAnchor: "anchor",
        insert: "after",
      })

      expect(result.output).toContain("lines 1-5")
    })

    test("output reports correct file paths", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "my_source.ts")
      const dst = path.join(tmp.path, "my_dest.ts")

      await fs.writeFile(src, "snippet")
      await fs.writeFile(dst, "landing")

      const { result } = await runCopy(tmp, {
        sourceFile: src,
        sourceString: "snippet",
        destFile: dst,
        destAnchor: "landing",
        insert: "replace",
      })

      // Output must reference at least one of the files involved
      const mentionsFile =
        result.output.includes("my_source") || result.output.includes("my_dest")
      expect(mentionsFile).toBe(true)
    })
  })

  // =========================================================================
  // CONCURRENT CALLS (stress)
  // =========================================================================
  describe("concurrent execution", () => {
    test("parallel inserts into different files do not cross-contaminate", async () => {
      await using tmp = await tmpdir()

      const files = await Promise.all(
        Array.from({ length: 5 }, async (_, i) => {
          const src = path.join(tmp.path, `src${i}.txt`)
          const dst = path.join(tmp.path, `dst${i}.txt`)
          await fs.writeFile(src, `SRC_${i}`)
          await fs.writeFile(dst, `anchor_${i}`)
          return { src, dst, i }
        }),
      )

      await Promise.all(
        files.map(({ src, dst, i }) =>
          Effect.runPromise(
            provideInstance(tmp.path)(
              runCopyEffect(tmp.path, {
                sourceFile: src,
                sourceString: `SRC_${i}`,
                destFile: dst,
                destAnchor: `anchor_${i}`,
                insert: "after",
              }),
            ).pipe(Effect.provide(storeLayer)),
          ),
        ),
      )

      for (const { dst, i } of files) {
        const content = await fs.readFile(dst, "utf-8")
        expect(content).toContain(`SRC_${i}`)
        for (let j = 0; j < 5; j++) {
          if (j !== i) expect(content).not.toContain(`SRC_${j}`)
        }
      }
    })
  })

  // =========================================================================
  // NEWLINE INSERTION BUGS
  // =========================================================================
  describe("newline insertion bugs", () => {
    test("insert before adds newline between source and anchor", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "source.txt")
      const dst = path.join(tmp.path, "dest.txt")

      await fs.writeFile(src, "def hello():\n    print('hello')")
      await fs.writeFile(dst, "def foo():\n    print('foo')")

      const { content } = await runCopy(tmp, {
        sourceFile: src,
        sourceString: "def hello():\n    print('hello')",
        destFile: dst,
        destAnchor: "def foo():\n    print('foo')",
        insert: "before",
      })

      // MUST have blank line between functions
      expect(content).toBe("def hello():\n    print('hello')\ndef foo():\n    print('foo')")
    })

    test("insert after adds newline between anchor and source", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "source.txt")
      const dst = path.join(tmp.path, "dest.txt")

      await fs.writeFile(src, "def world():\n    print('world')")
      await fs.writeFile(dst, "def foo():\n    print('foo')")

      const { content } = await runCopy(tmp, {
        sourceFile: src,
        sourceString: "def world():\n    print('world')",
        destFile: dst,
        destAnchor: "def foo():\n    print('foo')",
        insert: "after",
      })

      // MUST have blank line between functions
      expect(content).toBe("def foo():\n    print('foo')\ndef world():\n    print('world')")
    })

    test("insert before with multiple lines preserves blank lines", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "source.ts")
      const dst = path.join(tmp.path, "dest.ts")

      await fs.writeFile(src, "class Foo {}\nclass Bar {}")
      await fs.writeFile(dst, "class Baz {}")

      const { content } = await runCopy(tmp, {
        sourceFile: src,
        sourceString: "class Foo {}\nclass Bar {}",
        destFile: dst,
        destAnchor: "class Baz {}",
        insert: "before",
      })

      // Must have newlines between all three classes
      expect(content).toBe("class Foo {}\nclass Bar {}\nclass Baz {}")
    })

    test("insert after with multiple lines preserves blank lines", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "s.txt")
      const dst = path.join(tmp.path, "d.txt")

      await fs.writeFile(src, "X\nY")
      await fs.writeFile(dst, "A")

      const { content } = await runCopy(tmp, {
        sourceFile: src,
        sourceString: "X\nY",
        destFile: dst,
        destAnchor: "A",
        insert: "after",
      })

      expect(content).toBe("A\nX\nY")
    })
  })

  // =========================================================================
  // WHITESPACE ANCHOR BUGS
  // =========================================================================
  describe("whitespace anchor bugs", () => {
    test("anchor with extra spaces matches", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "s.txt")
      const dst = path.join(tmp.path, "d.txt")

      await fs.writeFile(src, "NEW")
      // dest has 2 spaces after "def"
      await fs.writeFile(dst, "def  foo():\n    pass")

      const { content } = await runCopy(tmp, {
        sourceFile: src,
        sourceString: "NEW",
        destFile: dst,
        destAnchor: "def foo():", // anchor with 1 space
        insert: "replace",
      })

      expect(content).toContain("NEW")
    })

    test("anchor with tabs matches anchor with spaces", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "s.txt")
      const dst = path.join(tmp.path, "d.txt")

      await fs.writeFile(src, "CONTENT")
      // dest uses tab
      await fs.writeFile(dst, "def\tfoo():\n    pass")

      const { content } = await runCopy(tmp, {
        sourceFile: src,
        sourceString: "CONTENT",
        destFile: dst,
        destAnchor: "def foo():", // anchor with space
        insert: "replace",
      })

      expect(content).toContain("CONTENT")
    })

    test("whitespace difference is normalized for matching", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "src.ts")
      const dst = path.join(tmp.path, "dst.ts")

      await fs.writeFile(src, "HELPER")
      await fs.writeFile(dst, "function   helper() {}")

      const { content } = await runCopy(tmp, {
        sourceFile: src,
        sourceString: "HELPER",
        destFile: dst,
        destAnchor: "function helper() {}",
        insert: "replace",
      })

      expect(content).toContain("HELPER")
    })
  })

  // =========================================================================
  // INSERT POSITION BUGS
  // =========================================================================
  describe("insert position bugs", () => {
    test("insert after does not merge with next line", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "source.txt")
      const dst = path.join(tmp.path, "dest.txt")

      await fs.writeFile(src, "MIDDLE")
      await fs.writeFile(dst, "TOP\nMIDDLE_OLD\nBOTTOM")

      const { content } = await runCopy(tmp, {
        sourceFile: src,
        sourceString: "MIDDLE",
        destFile: dst,
        destAnchor: "TOP",
        insert: "after",
      })

      // MIDDLE should be inserted after TOP, NOT merge with MIDDLE_OLD
      expect(content).toBe("TOP\nMIDDLE\nMIDDLE_OLD\nBOTTOM")
    })

    test("insert before does not merge with anchor line", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "s.txt")
      const dst = path.join(tmp.path, "d.txt")

      await fs.writeFile(src, "INSERTED")
      await fs.writeFile(dst, "ORIGINAL\nNEXT")

      const { content } = await runCopy(tmp, {
        sourceFile: src,
        sourceString: "INSERTED",
        destFile: dst,
        destAnchor: "ORIGINAL",
        insert: "before",
      })

      expect(content).toBe("INSERTED\nORIGINAL\nNEXT")
      expect(content.indexOf("INSERTED\nORIGINAL")).toBeGreaterThan(-1)
    })

    test("insert after at end of file works correctly", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "s.txt")
      const dst = path.join(tmp.path, "d.txt")

      await fs.writeFile(src, "LAST")
      await fs.writeFile(dst, "A\nB")

      const { content } = await runCopy(tmp, {
        sourceFile: src,
        sourceString: "LAST",
        destFile: dst,
        destAnchor: "B",
        insert: "after",
      })

      // LAST goes AFTER B, with newline
      expect(content).toBe("A\nB\nLAST")
    })

    test("replace adds newline between source and after content", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "s.txt")
      const dst = path.join(tmp.path, "d.txt")

      await fs.writeFile(src, "NEW")
      await fs.writeFile(dst, "OLD\nexisting\nmore")

      const { content } = await runCopy(tmp, {
        sourceFile: src,
        sourceString: "NEW",
        destFile: dst,
        destAnchor: "OLD",
        insert: "replace",
      })

      // MUST have newline between NEW and existing
      expect(content).toBe("NEW\nexisting\nmore")
    })
  })

  // =========================================================================
  // AMBIGUOUS ANCHOR WARNING
  // =========================================================================
  describe("ambiguous anchor warning", () => {
    test("warning appears when anchor matches multiple times", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "s.txt")
      const dst = path.join(tmp.path, "d.txt")

      await fs.writeFile(src, "X")
      // anchor "DUPLICATE" appears twice
      await fs.writeFile(dst, "DUPLICATE\nA\nDUPLICATE\nB")

      const { result } = await runCopy(tmp, {
        sourceFile: src,
        sourceString: "X",
        destFile: dst,
        destAnchor: "DUPLICATE",
        insert: "after",
      })

      // Should warn about multiple matches
      expect(result.output).toContain("matched 2 times")
      expect(result.output).toContain("used first occurrence")
    })

    test("no warning when anchor matches once", async () => {
      await using tmp = await tmpdir()
      const src = path.join(tmp.path, "s.txt")
      const dst = path.join(tmp.path, "d.txt")

      await fs.writeFile(src, "X")
      await fs.writeFile(dst, "UNIQUE\ncontent")

      const { result } = await runCopy(tmp, {
        sourceFile: src,
        sourceString: "X",
        destFile: dst,
        destAnchor: "UNIQUE",
        insert: "before",
      })

      // No warning
      expect(result.output).not.toContain("matched")
      expect(result.output).not.toContain("Warning")
    })
  })
})