import { afterEach, describe, expect, mock, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Config } from "@/config/config"
import { Agent } from "../../src/agent/agent"
import { Plugin } from "../../src/plugin"
import { SessionCompaction } from "../../src/session/compaction"
import { ContextGC } from "../../src/session/context-gc"
import { Session as SessionNs } from "@/session/session"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import type { Provider } from "@/provider/provider"
import * as SessionProcessorModule from "../../src/session/processor"
import { ProviderTest } from "../fake/provider"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

afterEach(() => {
  mock.restore()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

// ---------------------------------------------------------------------------
// Helpers: synthetic message builders for pure unit tests
// ---------------------------------------------------------------------------

let toolCallSeq = 0
const nextCallID = () => `call-${++toolCallSeq}`

const FAKE_SESSION_ID = SessionID.make("ses_test_synthetic")

function syntheticAssistant(id: number, parts: SessionV1.Part[]): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.make(`msg_a_${id}`),
      role: "assistant",
      sessionID: FAKE_SESSION_ID,
      agent: "build",
      mode: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      parentID: MessageID.make(`msg_u_${id}`),
      time: { created: id * 1000 },
      finish: "end_turn",
    } as SessionV1.Assistant,
    parts,
  }
}

function syntheticTool(input: {
  id: string
  msg: string
  tool: string
  toolInput: Record<string, unknown>
  output?: string
  metadata?: Record<string, unknown>
  compacted?: number
}): SessionV1.ToolPart {
  return {
    id: PartID.make(`prt_${input.id.replace(/-/g, "_")}`),
    messageID: MessageID.make(input.msg),
    sessionID: FAKE_SESSION_ID,
    type: "tool",
    callID: input.id,
    tool: input.tool,
    state: {
      status: "completed",
      input: input.toolInput,
      output: input.output ?? "ok",
      title: "t",
      metadata: input.metadata ?? {},
      time: { start: 0, end: 0, compacted: input.compacted },
    },
  }
}

// ===========================================================================
// Pure / unit tests against ContextGC.selectEvictions
// ===========================================================================

describe("ContextGC.selectEvictions / dedupe_reads", () => {
  test("evicts older read of the same file path", () => {
    const a = nextCallID()
    const b = nextCallID()
    const c = nextCallID()
    const messages = [
      syntheticAssistant(1, [
        syntheticTool({ id: a, msg: "msg_a_1", tool: "read", toolInput: { filePath: "/repo/a.ts" } }),
        syntheticTool({ id: b, msg: "msg_a_1", tool: "read", toolInput: { filePath: "/repo/b.ts" } }),
        syntheticTool({ id: c, msg: "msg_a_1", tool: "read", toolInput: { filePath: "/repo/a.ts" } }),
      ]),
    ]
    const evicted = ContextGC.selectEvictions(messages, {})
    expect(evicted.has(a)).toBe(true)
    expect(evicted.has(b)).toBe(false)
    expect(evicted.has(c)).toBe(false)
  })

  test("evicts every intermediate re-read of the same path", () => {
    const a = nextCallID()
    const b = nextCallID()
    const c = nextCallID()
    const messages = [
      syntheticAssistant(1, [
        syntheticTool({ id: a, msg: "msg_a_1", tool: "read", toolInput: { filePath: "/x" } }),
        syntheticTool({ id: b, msg: "msg_a_1", tool: "read", toolInput: { filePath: "/x" } }),
        syntheticTool({ id: c, msg: "msg_a_1", tool: "read", toolInput: { filePath: "/x" } }),
      ]),
    ]
    const evicted = ContextGC.selectEvictions(messages, {})
    expect(evicted.has(a)).toBe(true)
    expect(evicted.has(b)).toBe(true)
    expect(evicted.has(c)).toBe(false)
  })

  test("does nothing when rule is disabled and no other rule fires", () => {
    const a = nextCallID()
    const b = nextCallID()
    const messages = [
      syntheticAssistant(1, [
        syntheticTool({ id: a, msg: "msg_a_1", tool: "read", toolInput: { filePath: "/x" } }),
        syntheticTool({ id: b, msg: "msg_a_1", tool: "read", toolInput: { filePath: "/x" } }),
      ]),
    ]
    const evicted = ContextGC.selectEvictions(messages, { dedupe_reads: false, evict_on_modify: false })
    expect(evicted.size).toBe(0)
  })

  test("ignores reads without a string filePath", () => {
    const a = nextCallID()
    const b = nextCallID()
    const messages = [
      syntheticAssistant(1, [
        syntheticTool({ id: a, msg: "msg_a_1", tool: "read", toolInput: {} }),
        syntheticTool({ id: b, msg: "msg_a_1", tool: "read", toolInput: { filePath: 42 } }),
      ]),
    ]
    expect(ContextGC.selectEvictions(messages, {}).size).toBe(0)
  })
})

describe("ContextGC.selectEvictions / evict_on_modify", () => {
  test("evicts every prior read of a file that was later edited", () => {
    const r1 = nextCallID()
    const r2 = nextCallID()
    const e = nextCallID()
    const messages = [
      syntheticAssistant(1, [
        syntheticTool({ id: r1, msg: "msg_a_1", tool: "read", toolInput: { filePath: "/repo/a.ts" } }),
        syntheticTool({ id: r2, msg: "msg_a_1", tool: "read", toolInput: { filePath: "/repo/a.ts" } }),
        syntheticTool({
          id: e,
          msg: "msg_a_1",
          tool: "edit",
          toolInput: { filePath: "/repo/a.ts", oldString: "x", newString: "y" },
        }),
      ]),
    ]
    const evicted = ContextGC.selectEvictions(messages, { dedupe_reads: false })
    expect(evicted.has(r1)).toBe(true)
    expect(evicted.has(r2)).toBe(true)
    expect(evicted.has(e)).toBe(false)
  })

  test("write invalidates earlier reads of the same path", () => {
    const r = nextCallID()
    const w = nextCallID()
    const messages = [
      syntheticAssistant(1, [
        syntheticTool({ id: r, msg: "msg_a_1", tool: "read", toolInput: { filePath: "/repo/a.ts" } }),
        syntheticTool({ id: w, msg: "msg_a_1", tool: "write", toolInput: { filePath: "/repo/a.ts", content: "new" } }),
      ]),
    ]
    const evicted = ContextGC.selectEvictions(messages, { dedupe_reads: false })
    expect(evicted.has(r)).toBe(true)
  })

  test("apply_patch invalidates reads of every file listed in metadata.files", () => {
    const ra = nextCallID()
    const rb = nextCallID()
    const rc = nextCallID()
    const patch = nextCallID()
    const messages = [
      syntheticAssistant(1, [
        syntheticTool({ id: ra, msg: "msg_a_1", tool: "read", toolInput: { filePath: "/repo/a.ts" } }),
        syntheticTool({ id: rb, msg: "msg_a_1", tool: "read", toolInput: { filePath: "/repo/b.ts" } }),
        syntheticTool({ id: rc, msg: "msg_a_1", tool: "read", toolInput: { filePath: "/repo/c.ts" } }),
        syntheticTool({
          id: patch,
          msg: "msg_a_1",
          tool: "apply_patch",
          toolInput: { patchText: "..." },
          metadata: {
            files: [
              { filePath: "/repo/a.ts", relativePath: "a.ts", type: "update" },
              { filePath: "/repo/b.ts", relativePath: "b.ts", type: "delete" },
            ],
          },
        }),
      ]),
    ]
    const evicted = ContextGC.selectEvictions(messages, { dedupe_reads: false })
    expect(evicted.has(ra)).toBe(true)
    expect(evicted.has(rb)).toBe(true)
    expect(evicted.has(rc)).toBe(false)
  })

  test("apply_patch with a move also evicts reads of the move target", () => {
    const rb = nextCallID()
    const patch = nextCallID()
    const messages = [
      syntheticAssistant(1, [
        syntheticTool({ id: rb, msg: "msg_a_1", tool: "read", toolInput: { filePath: "/repo/dest.ts" } }),
        syntheticTool({
          id: patch,
          msg: "msg_a_1",
          tool: "apply_patch",
          toolInput: { patchText: "..." },
          metadata: {
            files: [{ filePath: "/repo/source.ts", movePath: "/repo/dest.ts", type: "move" }],
          },
        }),
      ]),
    ]
    const evicted = ContextGC.selectEvictions(messages, { dedupe_reads: false })
    expect(evicted.has(rb)).toBe(true)
  })

  test("read after a modify of the same path is preserved", () => {
    const r1 = nextCallID()
    const e = nextCallID()
    const r2 = nextCallID()
    const messages = [
      syntheticAssistant(1, [
        syntheticTool({ id: r1, msg: "msg_a_1", tool: "read", toolInput: { filePath: "/repo/a.ts" } }),
        syntheticTool({
          id: e,
          msg: "msg_a_1",
          tool: "edit",
          toolInput: { filePath: "/repo/a.ts", oldString: "x", newString: "y" },
        }),
        syntheticTool({ id: r2, msg: "msg_a_1", tool: "read", toolInput: { filePath: "/repo/a.ts" } }),
      ]),
    ]
    const evicted = ContextGC.selectEvictions(messages, { dedupe_reads: false })
    expect(evicted.has(r1)).toBe(true)
    expect(evicted.has(r2)).toBe(false)
  })
})

describe("ContextGC.selectEvictions / dedupe_shell", () => {
  test("off by default", () => {
    const a = nextCallID()
    const b = nextCallID()
    const messages = [
      syntheticAssistant(1, [
        syntheticTool({ id: a, msg: "msg_a_1", tool: "bash", toolInput: { command: "ls", cwd: "/" } }),
        syntheticTool({ id: b, msg: "msg_a_1", tool: "bash", toolInput: { command: "ls", cwd: "/" } }),
      ]),
    ]
    expect(ContextGC.selectEvictions(messages, {}).size).toBe(0)
  })

  test("when enabled, drops older identical commands", () => {
    const a = nextCallID()
    const b = nextCallID()
    const c = nextCallID()
    const messages = [
      syntheticAssistant(1, [
        syntheticTool({ id: a, msg: "msg_a_1", tool: "bash", toolInput: { command: "ls -la", cwd: "/repo" } }),
        syntheticTool({ id: b, msg: "msg_a_1", tool: "bash", toolInput: { command: "ls -la", cwd: "/other" } }),
        syntheticTool({ id: c, msg: "msg_a_1", tool: "bash", toolInput: { command: "ls -la", cwd: "/repo" } }),
      ]),
    ]
    const evicted = ContextGC.selectEvictions(messages, { dedupe_shell: true })
    expect(evicted.has(a)).toBe(true)
    expect(evicted.has(b)).toBe(false)
    expect(evicted.has(c)).toBe(false)
  })
})

describe("ContextGC.selectEvictions / dedupe_grep", () => {
  test("off by default", () => {
    const a = nextCallID()
    const b = nextCallID()
    const messages = [
      syntheticAssistant(1, [
        syntheticTool({ id: a, msg: "msg_a_1", tool: "grep", toolInput: { pattern: "TODO" } }),
        syntheticTool({ id: b, msg: "msg_a_1", tool: "grep", toolInput: { pattern: "TODO" } }),
      ]),
    ]
    expect(ContextGC.selectEvictions(messages, {}).size).toBe(0)
  })

  test("matches on pattern + path + include triple", () => {
    const a = nextCallID()
    const b = nextCallID()
    const c = nextCallID()
    const messages = [
      syntheticAssistant(1, [
        syntheticTool({ id: a, msg: "msg_a_1", tool: "grep", toolInput: { pattern: "x", path: "/src", include: "*.ts" } }),
        syntheticTool({ id: b, msg: "msg_a_1", tool: "grep", toolInput: { pattern: "x", path: "/src", include: "*.tsx" } }),
        syntheticTool({ id: c, msg: "msg_a_1", tool: "grep", toolInput: { pattern: "x", path: "/src", include: "*.ts" } }),
      ]),
    ]
    const evicted = ContextGC.selectEvictions(messages, { dedupe_grep: true })
    expect(evicted.has(a)).toBe(true)
    expect(evicted.has(b)).toBe(false)
    expect(evicted.has(c)).toBe(false)
  })
})

describe("ContextGC.selectEvictions / dedupe_glob", () => {
  test("off by default", () => {
    const a = nextCallID()
    const b = nextCallID()
    const messages = [
      syntheticAssistant(1, [
        syntheticTool({ id: a, msg: "msg_a_1", tool: "glob", toolInput: { pattern: "*.ts", path: "/src" } }),
        syntheticTool({ id: b, msg: "msg_a_1", tool: "glob", toolInput: { pattern: "*.ts", path: "/src" } }),
      ]),
    ]
    expect(ContextGC.selectEvictions(messages, {}).size).toBe(0)
  })

  test("when enabled, drops older matching globs", () => {
    const a = nextCallID()
    const b = nextCallID()
    const messages = [
      syntheticAssistant(1, [
        syntheticTool({ id: a, msg: "msg_a_1", tool: "glob", toolInput: { pattern: "*.ts", path: "/src" } }),
        syntheticTool({ id: b, msg: "msg_a_1", tool: "glob", toolInput: { pattern: "*.ts", path: "/src" } }),
      ]),
    ]
    const evicted = ContextGC.selectEvictions(messages, { dedupe_glob: true })
    expect(evicted.has(a)).toBe(true)
    expect(evicted.has(b)).toBe(false)
  })
})

describe("ContextGC.selectEvictions / dedupe_webfetch", () => {
  test("on by default", () => {
    const a = nextCallID()
    const b = nextCallID()
    const messages = [
      syntheticAssistant(1, [
        syntheticTool({ id: a, msg: "msg_a_1", tool: "webfetch", toolInput: { url: "https://x.com" } }),
        syntheticTool({ id: b, msg: "msg_a_1", tool: "webfetch", toolInput: { url: "https://x.com" } }),
      ]),
    ]
    const evicted = ContextGC.selectEvictions(messages, {})
    expect(evicted.has(a)).toBe(true)
    expect(evicted.has(b)).toBe(false)
  })

  test("opting out preserves both", () => {
    const a = nextCallID()
    const b = nextCallID()
    const messages = [
      syntheticAssistant(1, [
        syntheticTool({ id: a, msg: "msg_a_1", tool: "webfetch", toolInput: { url: "https://x.com" } }),
        syntheticTool({ id: b, msg: "msg_a_1", tool: "webfetch", toolInput: { url: "https://x.com" } }),
      ]),
    ]
    expect(ContextGC.selectEvictions(messages, { dedupe_webfetch: false }).size).toBe(0)
  })

  test("different URLs are not deduped", () => {
    const a = nextCallID()
    const b = nextCallID()
    const messages = [
      syntheticAssistant(1, [
        syntheticTool({ id: a, msg: "msg_a_1", tool: "webfetch", toolInput: { url: "https://x.com" } }),
        syntheticTool({ id: b, msg: "msg_a_1", tool: "webfetch", toolInput: { url: "https://y.com" } }),
      ]),
    ]
    expect(ContextGC.selectEvictions(messages, {}).size).toBe(0)
  })
})

describe("ContextGC.selectEvictions / protections", () => {
  test("never evicts protected `skill` tool outputs", () => {
    const a = nextCallID()
    const b = nextCallID()
    const messages = [
      syntheticAssistant(1, [
        syntheticTool({ id: a, msg: "msg_a_1", tool: "skill", toolInput: { filePath: "/x" } }),
        syntheticTool({ id: b, msg: "msg_a_1", tool: "skill", toolInput: { filePath: "/x" } }),
      ]),
    ]
    expect(ContextGC.selectEvictions(messages, {}).size).toBe(0)
  })

  test("already-compacted parts are not re-evicted", () => {
    const a = nextCallID()
    const b = nextCallID()
    const c = nextCallID()
    const messages = [
      syntheticAssistant(1, [
        syntheticTool({ id: a, msg: "msg_a_1", tool: "read", toolInput: { filePath: "/x" }, compacted: 12345 }),
        syntheticTool({ id: b, msg: "msg_a_1", tool: "read", toolInput: { filePath: "/x" } }),
        syntheticTool({ id: c, msg: "msg_a_1", tool: "read", toolInput: { filePath: "/x" } }),
      ]),
    ]
    const evicted = ContextGC.selectEvictions(messages, {})
    expect(evicted.has(a)).toBe(false)
    expect(evicted.has(b)).toBe(true)
    expect(evicted.has(c)).toBe(false)
  })

  test("returns empty when no completed tool calls exist", () => {
    const messages = [
      {
        info: {
          id: MessageID.make("msg_u_1"),
          role: "user",
          sessionID: FAKE_SESSION_ID,
          agent: "build",
          model: ref,
          time: { created: 1000 },
        } as SessionV1.User,
        parts: [],
      } satisfies SessionV1.WithParts,
    ]
    expect(ContextGC.selectEvictions(messages, {}).size).toBe(0)
  })
})

describe("ContextGC / isActive", () => {
  test("active when called with no overrides (defaults apply)", () => {
    expect(ContextGC.isActive(undefined)).toBe(true)
    expect(ContextGC.isActive({})).toBe(true)
  })

  test("inactive when every default-on rule is explicitly disabled and no opt-in rule fires", () => {
    expect(
      ContextGC.isActive({
        dedupe_reads: false,
        evict_on_modify: false,
        dedupe_webfetch: false,
      }),
    ).toBe(false)
  })

  test("active when an opt-in rule is turned on", () => {
    expect(
      ContextGC.isActive({
        dedupe_reads: false,
        evict_on_modify: false,
        dedupe_webfetch: false,
        dedupe_shell: true,
      }),
    ).toBe(true)
  })
})

describe("ContextGC.selectEvictions / combined rules", () => {
  test("dedupe_reads + evict_on_modify together", () => {
    const r1 = nextCallID()
    const r2 = nextCallID()
    const e = nextCallID()
    const r3 = nextCallID()
    const messages = [
      syntheticAssistant(1, [
        syntheticTool({ id: r1, msg: "msg_a_1", tool: "read", toolInput: { filePath: "/a.ts" } }),
        syntheticTool({ id: r2, msg: "msg_a_1", tool: "read", toolInput: { filePath: "/a.ts" } }),
        syntheticTool({ id: e, msg: "msg_a_1", tool: "edit", toolInput: { filePath: "/a.ts", oldString: "x", newString: "y" } }),
        syntheticTool({ id: r3, msg: "msg_a_1", tool: "read", toolInput: { filePath: "/a.ts" } }),
      ]),
    ]
    const evicted = ContextGC.selectEvictions(messages, {})
    expect(evicted.has(r1)).toBe(true)
    expect(evicted.has(r2)).toBe(true)
    expect(evicted.has(e)).toBe(false)
    expect(evicted.has(r3)).toBe(false)
  })

  test("multiple tools in one pass", () => {
    const readA1 = nextCallID()
    const readA2 = nextCallID()
    const fetchU1 = nextCallID()
    const fetchU2 = nextCallID()
    const bashC1 = nextCallID()
    const bashC2 = nextCallID()
    const messages = [
      syntheticAssistant(1, [
        syntheticTool({ id: readA1, msg: "msg_a_1", tool: "read", toolInput: { filePath: "/a" } }),
        syntheticTool({ id: fetchU1, msg: "msg_a_1", tool: "webfetch", toolInput: { url: "https://x" } }),
        syntheticTool({ id: bashC1, msg: "msg_a_1", tool: "bash", toolInput: { command: "echo hi", cwd: "/" } }),
        syntheticTool({ id: readA2, msg: "msg_a_1", tool: "read", toolInput: { filePath: "/a" } }),
        syntheticTool({ id: fetchU2, msg: "msg_a_1", tool: "webfetch", toolInput: { url: "https://x" } }),
        syntheticTool({ id: bashC2, msg: "msg_a_1", tool: "bash", toolInput: { command: "echo hi", cwd: "/" } }),
      ]),
    ]
    const evicted = ContextGC.selectEvictions(messages, { dedupe_shell: true })
    expect(evicted.has(readA1)).toBe(true)
    expect(evicted.has(readA2)).toBe(false)
    expect(evicted.has(fetchU1)).toBe(true)
    expect(evicted.has(fetchU2)).toBe(false)
    expect(evicted.has(bashC1)).toBe(true)
    expect(evicted.has(bashC2)).toBe(false)
  })
})

// ===========================================================================
// Integration tests through SessionCompaction.prune
// ===========================================================================

function createModel(opts: { context: number; output: number }): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: { context: opts.context, output: opts.output },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

const wide = () => ProviderTest.fake({ model: createModel({ context: 100_000, output: 32_000 }) })

function fakeProcessor() {
  return Layer.succeed(
    SessionProcessorModule.SessionProcessor.Service,
    SessionProcessorModule.SessionProcessor.Service.of({
      create: Effect.fn("TestSessionProcessor.create")((input) =>
        Effect.succeed({
          get message() {
            return input.assistantMessage
          },
          updateToolCall: Effect.fn("TestSessionProcessor.updateToolCall")(() => Effect.succeed(undefined)),
          completeToolCall: Effect.fn("TestSessionProcessor.completeToolCall")(() => Effect.void),
          process: Effect.fn("TestSessionProcessor.process")(() => Effect.succeed("continue" as const)),
        } satisfies SessionProcessorModule.SessionProcessor.Handle),
      ),
    }),
  )
}

const deps = Layer.mergeAll(
  wide().layer,
  fakeProcessor(),
  Agent.defaultLayer,
  Plugin.defaultLayer,
  Config.defaultLayer,
  RuntimeFlags.layer({ experimentalEventSystem: true }),
  EventV2Bridge.defaultLayer,
)

const env = Layer.mergeAll(
  SessionNs.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  SessionCompaction.layer.pipe(
    Layer.provide(SessionNs.defaultLayer),
    Layer.provideMerge(deps),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
  ),
) as Layer.Layer<any, any, never>

const it = testEffect(env)

function makeUser(sessionID: SessionID, text: string) {
  return Effect.gen(function* () {
    const ssn = yield* SessionNs.Service
    const msg = yield* ssn.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: ref,
      time: { created: Date.now() },
    })
    yield* ssn.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID,
      type: "text",
      text,
    })
    return msg
  })
}

function makeAssistant(sessionID: SessionID, parentID: MessageID, dir: string) {
  return Effect.gen(function* () {
    const ssn = yield* SessionNs.Service
    const msg: SessionV1.Assistant = {
      id: MessageID.ascending(),
      role: "assistant",
      sessionID,
      mode: "build",
      agent: "build",
      path: { cwd: dir, root: dir },
      cost: 0,
      tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      parentID,
      time: { created: Date.now() },
      finish: "end_turn",
    }
    yield* ssn.updateMessage(msg)
    return msg
  })
}

function makeToolPart(
  sessionID: SessionID,
  messageID: MessageID,
  spec: { tool: string; input: Record<string, unknown>; output?: string; metadata?: Record<string, unknown> },
) {
  return Effect.gen(function* () {
    const ssn = yield* SessionNs.Service
    return yield* ssn.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "tool",
      callID: crypto.randomUUID(),
      tool: spec.tool,
      state: {
        status: "completed",
        input: spec.input,
        output: spec.output ?? "ok",
        title: "done",
        metadata: spec.metadata ?? {},
        time: { start: Date.now(), end: Date.now() },
      },
    })
  })
}

describe("session.compaction.prune / smart GC integration", () => {
  it.live(
    "compacts the earlier read of the same file but keeps the latest",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const compact = yield* SessionCompaction.Service
          const ssn = yield* SessionNs.Service
          const info = yield* ssn.create({})
          const u1 = yield* makeUser(info.id, "first")
          const a1 = yield* makeAssistant(info.id, u1.id, dir)
          const olderRead = yield* makeToolPart(info.id, a1.id, {
            tool: "read",
            input: { filePath: "/repo/foo.ts" },
            output: "OLD",
          })
          const newerRead = yield* makeToolPart(info.id, a1.id, {
            tool: "read",
            input: { filePath: "/repo/foo.ts" },
            output: "NEW",
          })
          yield* makeUser(info.id, "second")
          yield* makeUser(info.id, "third")

          yield* compact.prune({ sessionID: info.id })

          const msgs = yield* ssn.messages({ sessionID: info.id })
          const parts = msgs
            .flatMap((m) => m.parts)
            .filter((p): p is SessionV1.ToolPart => p.type === "tool")

          const older = parts.find((p) => p.id === olderRead.id)
          const newer = parts.find((p) => p.id === newerRead.id)
          expect(older?.state.status).toBe("completed")
          expect(newer?.state.status).toBe("completed")
          if (older?.state.status === "completed") {
            expect(older.state.time.compacted).toBeNumber()
          }
          if (newer?.state.status === "completed") {
            expect(newer.state.time.compacted).toBeUndefined()
          }
        }),
      {
        config: {
          compaction: { prune: true, smart_gc: true } as any,
        },
      },
    ),
  )

  it.live(
    "compacts every read of a file that a later edit modified",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const compact = yield* SessionCompaction.Service
          const ssn = yield* SessionNs.Service
          const info = yield* ssn.create({})
          const u1 = yield* makeUser(info.id, "first")
          const a1 = yield* makeAssistant(info.id, u1.id, dir)
          const r1 = yield* makeToolPart(info.id, a1.id, {
            tool: "read",
            input: { filePath: "/repo/a.ts" },
            output: "v1",
          })
          const r2 = yield* makeToolPart(info.id, a1.id, {
            tool: "read",
            input: { filePath: "/repo/a.ts" },
            output: "v2",
          })
          const ed = yield* makeToolPart(info.id, a1.id, {
            tool: "edit",
            input: { filePath: "/repo/a.ts", oldString: "x", newString: "y" },
            output: "edited",
          })
          yield* makeUser(info.id, "second")
          yield* makeUser(info.id, "third")

          yield* compact.prune({ sessionID: info.id })

          const msgs = yield* ssn.messages({ sessionID: info.id })
          const parts = msgs
            .flatMap((m) => m.parts)
            .filter((p): p is SessionV1.ToolPart => p.type === "tool")

          const first = parts.find((p) => p.id === r1.id)
          const second = parts.find((p) => p.id === r2.id)
          const edit = parts.find((p) => p.id === ed.id)
          if (first?.state.status === "completed") {
            expect(first.state.time.compacted).toBeNumber()
          }
          if (second?.state.status === "completed") {
            expect(second.state.time.compacted).toBeNumber()
          }
          if (edit?.state.status === "completed") {
            expect(edit.state.time.compacted).toBeUndefined()
          }
        }),
      {
        config: {
          compaction: { prune: true, smart_gc: true } as any,
        },
      },
    ),
  )

  it.live(
    "smart_gc=false disables content-aware eviction (older reads survive small contexts)",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const compact = yield* SessionCompaction.Service
          const ssn = yield* SessionNs.Service
          const info = yield* ssn.create({})
          const u1 = yield* makeUser(info.id, "first")
          const a1 = yield* makeAssistant(info.id, u1.id, dir)
          const r1 = yield* makeToolPart(info.id, a1.id, {
            tool: "read",
            input: { filePath: "/repo/foo.ts" },
            output: "old",
          })
          yield* makeToolPart(info.id, a1.id, {
            tool: "read",
            input: { filePath: "/repo/foo.ts" },
            output: "new",
          })
          yield* makeUser(info.id, "second")
          yield* makeUser(info.id, "third")

          yield* compact.prune({ sessionID: info.id })

          const msgs = yield* ssn.messages({ sessionID: info.id })
          const earlier = msgs
            .flatMap((m) => m.parts)
            .filter((p): p is SessionV1.ToolPart => p.type === "tool")
            .find((p) => p.id === r1.id)
          if (earlier?.state.status === "completed") {
            expect(earlier.state.time.compacted).toBeUndefined()
          }
        }),
      {
        config: {
          compaction: { prune: true, smart_gc: false } as any,
        },
      },
    ),
  )

  it.live(
    "respects PROTECTED_TOOLS — never evicts `skill` parts even when they share inputs",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const compact = yield* SessionCompaction.Service
          const ssn = yield* SessionNs.Service
          const info = yield* ssn.create({})
          const u1 = yield* makeUser(info.id, "first")
          const a1 = yield* makeAssistant(info.id, u1.id, dir)
          const skillA = yield* makeToolPart(info.id, a1.id, {
            tool: "skill",
            input: { filePath: "/dup" },
            output: "rules1",
          })
          const skillB = yield* makeToolPart(info.id, a1.id, {
            tool: "skill",
            input: { filePath: "/dup" },
            output: "rules2",
          })
          yield* makeUser(info.id, "second")
          yield* makeUser(info.id, "third")

          yield* compact.prune({ sessionID: info.id })

          const msgs = yield* ssn.messages({ sessionID: info.id })
          const parts = msgs
            .flatMap((m) => m.parts)
            .filter((p): p is SessionV1.ToolPart => p.type === "tool")
          for (const id of [skillA.id, skillB.id]) {
            const part = parts.find((p) => p.id === id)
            if (part?.state.status === "completed") {
              expect(part.state.time.compacted).toBeUndefined()
            }
          }
        }),
      {
        config: {
          compaction: { prune: true, smart_gc: true } as any,
        },
      },
    ),
  )
})
