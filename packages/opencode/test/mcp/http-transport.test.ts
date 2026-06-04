import { describe, expect, mock, beforeEach } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { testEffect } from "../lib/effect"

// ── Mock infrastructure ──────────────────────────────────────────────

const transportCalls: Array<{
  type: "streamable" | "sse"
  url: string
  options?: { authProvider?: unknown; requestInit?: RequestInit }
}> = []

let streamableShouldFail = false
let connectShouldHang = false
let transportShouldThrowAuth = false
let transportAuthMsg = "Unauthorized"
let transportCloseCount = 0
let clientCreateCount = 0

// Define UnauthorizedError before mocking so both mock transport and test
// code share the same class (instanceof check in connectHttp)
class MockUnauthorizedError extends Error {
  constructor(msg?: string) {
    super(msg ?? "Unauthorized")
    this.name = "UnauthorizedError"
  }
}

void mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTP {
    constructor(url: URL, options?: { authProvider?: unknown; requestInit?: RequestInit }) {
      transportCalls.push({
        type: "streamable",
        url: url.toString(),
        options: options ?? {},
      })
    }
    async start() {
      if (connectShouldHang) return new Promise<void>(() => {})
      if (transportShouldThrowAuth) throw new MockUnauthorizedError(transportAuthMsg)
      if (streamableShouldFail) throw new Error("StreamableHTTP failed")
    }
    async close() {
      transportCloseCount++
    }
    async finishAuth() {}
  },
}))

void mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockSSE {
    constructor(url: URL, options?: { authProvider?: unknown; requestInit?: RequestInit }) {
      transportCalls.push({
        type: "sse",
        url: url.toString(),
        options: options ?? {},
      })
    }
    async start() {
      throw new Error("SSE failed")
    }
    async close() {
      transportCloseCount++
    }
  },
}))

void mock.module("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError: MockUnauthorizedError,
}))

void mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    transport: any

    constructor() {
      clientCreateCount++
    }
    async connect(transport: { start: () => Promise<void> }) {
      this.transport = transport
      await transport.start()
    }
    async close() {
      if (this.transport) {
        await this.transport.close()
      }
    }
    async listTools() {
      return { tools: [] }
    }
    async listPrompts() {
      return { prompts: [] }
    }
    async listResources() {
      return { resources: [] }
    }
    setNotificationHandler() {}
    async request(
      _request: { method: string },
      schema: { parse: (value: unknown) => unknown },
    ) {
      return schema.parse({ tools: [] })
    }
  },
}))

beforeEach(() => {
  transportCalls.length = 0
  streamableShouldFail = false
  connectShouldHang = false
  transportShouldThrowAuth = false
  transportAuthMsg = "Unauthorized"
  transportCloseCount = 0
  clientCreateCount = 0
})

const { MCP } = await import("../../src/mcp/index")
const it = testEffect(MCP.defaultLayer)

// ── Helpers ──────────────────────────────────────────────────────────

function getStatus(
  result: { status: Record<string, unknown> | unknown },
  name: string,
): { status: string; error?: string } {
  const dict = result.status as Record<string, { status: string; error?: string }>
  return dict[name] ?? (result.status as { status: string; error?: string })
}

// ── Tests ────────────────────────────────────────────────────────────

describe("mcp.http-transport", () => {
  // ── Basic connection ──

  it.instance(
    "creates only StreamableHTTP transport for type http",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const result = yield* mcp.add("http-server", {
          type: "http",
          url: "https://example.com/mcp",
        })

        const status = getStatus(result, "http-server")
        expect(status.status).toBe("connected")
        expect(transportCalls.length).toBe(1)
        expect(transportCalls[0].type).toBe("streamable")
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "does not create SSE transport for type http",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.add("http-only", {
          type: "http",
          url: "https://example.com/mcp",
        })

        const sseCalls = transportCalls.filter((c) => c.type === "sse")
        expect(sseCalls.length).toBe(0)
      }),
    { config: { mcp: {} } },
  )

  // ── Failure modes ──

  it.instance(
    "marks server as failed when StreamableHTTP fails for type http (no SSE fallback)",
    () =>
      Effect.gen(function* () {
        streamableShouldFail = true
        const mcp = yield* MCP.Service
        const result = yield* mcp.add("http-server-fail", {
          type: "http",
          url: "https://example.com/mcp",
        })

        const status = getStatus(result, "http-server-fail")
        expect(status.status).toBe("failed")
        expect(status.error).toBe("StreamableHTTP failed")
        // Only StreamableHTTP was attempted — no SSE fallback
        expect(transportCalls.length).toBe(1)
        expect(transportCalls[0].type).toBe("streamable")
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "returns needs_auth when StreamableHTTP throws UnauthorizedError",
    () =>
      Effect.gen(function* () {
        transportShouldThrowAuth = true
        transportAuthMsg = "Unauthorized"
        const mcp = yield* MCP.Service
        const result = yield* mcp.add("http-server-auth", {
          type: "http",
          url: "https://example.com/mcp",
        })

        const status = getStatus(result, "http-server-auth")
        expect(status.status).toBe("needs_auth")
        expect(transportCalls.length).toBe(1)
        expect(transportCalls[0].type).toBe("streamable")
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "returns needs_client_registration when UnauthorizedError mentions registration",
    () =>
      Effect.gen(function* () {
        transportShouldThrowAuth = true
        transportAuthMsg = "Client registration required"
        const mcp = yield* MCP.Service
        const result = yield* mcp.add("http-server-reg", {
          type: "http",
          url: "https://example.com/mcp",
        })

        const status = getStatus(result, "http-server-reg")
        expect(status.status).toBe("needs_client_registration")
        expect(status.error).toContain("clientId")
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "returns needs_client_registration when UnauthorizedError mentions client_id",
    () =>
      Effect.gen(function* () {
        transportShouldThrowAuth = true
        transportAuthMsg = "Unknown client_id"
        const mcp = yield* MCP.Service
        const result = yield* mcp.add("http-server-cid", {
          type: "http",
          url: "https://example.com/mcp",
        })

        const status = getStatus(result, "http-server-cid")
        expect(status.status).toBe("needs_client_registration")
        expect(status.error).toContain("clientId")
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "invalid URL returns failed status without creating transport",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const result = yield* mcp.add("http-server-badurl", {
          type: "http",
          url: "not-a-valid-url",
        })

        const status = getStatus(result, "http-server-badurl")
        expect(status.status).toBe("failed")
        expect(transportCalls.length).toBe(0)
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "closes transport on timeout for type http",
    () =>
      Effect.gen(function* () {
        connectShouldHang = true
        const mcp = yield* MCP.Service
        const result = yield* mcp.add("http-server-hang", {
          type: "http",
          url: "https://example.com/mcp",
          timeout: 100,
        })

        const status = getStatus(result, "http-server-hang")
        expect(status.status).toBe("failed")
        expect(status.error).toContain("timed out")
        expect(transportCloseCount).toBeGreaterThanOrEqual(1)
      }),
    { config: { mcp: {} } },
  )

  // ── OAuth config ──

  it.instance(
    "connects successfully with oauth disabled for type http",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const result = yield* mcp.add("http-server-noauth", {
          type: "http",
          url: "https://example.com/mcp",
          oauth: false,
        })

        const status = getStatus(result, "http-server-noauth")
        expect(status.status).toBe("connected")
        expect(transportCalls.length).toBe(1)
        expect(transportCalls[0].type).toBe("streamable")
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "passes OAuth authProvider to transport for type http by default",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.add("http-server-oauth-default", {
          type: "http",
          url: "https://example.com/mcp",
        })

        expect(transportCalls.length).toBe(1)
        expect(transportCalls[0].options?.authProvider).toBeDefined()
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "does not pass authProvider when oauth is false for type http",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.add("http-server-oauth-off", {
          type: "http",
          url: "https://example.com/mcp",
          oauth: false,
        })

        expect(transportCalls.length).toBe(1)
        expect(transportCalls[0].options?.authProvider).toBeUndefined()
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "passes headers to StreamableHTTP for type http",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.add("http-server-headers", {
          type: "http",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer test-token" },
        })

        expect(transportCalls.length).toBe(1)
        expect(transportCalls[0].options?.requestInit).toBeDefined()
        expect(transportCalls[0].options?.requestInit?.headers).toEqual({
          Authorization: "Bearer test-token",
        })
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "no requestInit when headers are not provided for type http",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.add("http-server-no-headers", {
          type: "http",
          url: "https://example.com/mcp",
        })

        expect(transportCalls.length).toBe(1)
        expect(transportCalls[0].options?.requestInit).toBeUndefined()
      }),
    { config: { mcp: {} } },
  )

  // ── supportsOAuth ──

  it.instance(
    "supportsOAuth returns true for http type with default oauth",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.add("http-oauth-yes", { type: "http", url: "https://example.com/mcp" })
        const supported = yield* mcp.supportsOAuth("http-oauth-yes")
        expect(supported).toBe(true)
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "supportsOAuth returns false for http type with oauth disabled",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.add("http-oauth-no", {
          type: "http",
          url: "https://example.com/mcp",
          oauth: false,
        })
        const supported = yield* mcp.supportsOAuth("http-oauth-no")
        expect(supported).toBe(false)
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "supportsOAuth throws NotFoundError for unknown http server",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const exit = yield* mcp.supportsOAuth("nonexistent").pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    { config: { mcp: {} } },
  )

  // ── Lifecycle: disconnect / reconnect ──

  it.instance(
    "disconnect marks http server as disabled and clears tools",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.add("http-disc", { type: "http", url: "https://example.com/mcp" })
        yield* mcp.disconnect("http-disc")

        const status = yield* mcp.status()
        expect(status["http-disc"]?.status).toBe("disabled")

        const tools = yield* mcp.tools()
        const hasTool = Object.keys(tools).some((k) => k.startsWith("http_disc"))
        expect(hasTool).toBe(false)
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "reconnect after disconnect re-establishes http server",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.add("http-recon", { type: "http", url: "https://example.com/mcp" })
        yield* mcp.disconnect("http-recon")
        yield* mcp.connect("http-recon")

        const status = yield* mcp.status()
        expect(status["http-recon"]?.status).toBe("connected")
      }),
    { config: { mcp: {} } },
  )

  // ── Multiple servers ──

  it.instance(
    "multiple http servers can be added concurrently",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.add("http-a", { type: "http", url: "https://a.example.com/mcp" })
        yield* mcp.add("http-b", { type: "http", url: "https://b.example.com/mcp" })

        const status = yield* mcp.status()
        expect(status["http-a"]?.status).toBe("connected")
        expect(status["http-b"]?.status).toBe("connected")
        expect(transportCalls.length).toBe(2)
        expect(transportCalls.every((c) => c.type === "streamable")).toBe(true)
      }),
    { config: { mcp: {} } },
  )

  // ── Disabled server ──

  it.instance(
    "disabled http server is skipped without transport creation",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.add("http-disabled", {
          type: "http",
          url: "https://example.com/mcp",
          enabled: false,
        })

        const status = yield* mcp.status()
        expect(status["http-disabled"]?.status).toBe("disabled")
        expect(transportCalls.length).toBe(0)
      }),
    { config: { mcp: {} } },
  )

  // ── Server replacement ──

  it.instance(
    "replacing an http server closes the old transport and reconnects",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.add("http-replace", { type: "http", url: "https://old.example.com/mcp" })
        const initialCloseCount = transportCloseCount

        yield* mcp.add("http-replace", { type: "http", url: "https://new.example.com/mcp" })

        const status = yield* mcp.status()
        expect(status["http-replace"]?.status).toBe("connected")
        // Old transport was closed, new transport created
        expect(transportCloseCount).toBeGreaterThan(initialCloseCount)
        expect(transportCalls.length).toBe(2)
        expect(transportCalls[1].url).toBe("https://new.example.com/mcp")
      }),
    { config: { mcp: {} } },
  )

  // ── status() / tools() ──

  it.instance(
    "status() and tools() work after http connect",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.add("http-tools-test", { type: "http", url: "https://example.com/mcp" })

        const status = yield* mcp.status()
        expect(status["http-tools-test"]?.status).toBe("connected")

        const tools = yield* mcp.tools()
        expect(tools).toEqual({})
      }),
    { config: { mcp: {} } },
  )

  // ── Config parsing ──

  it.instance(
    "type: http is parsed from initial config",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const status = yield* mcp.status()
        expect(status["cfg-http-server"]?.status).toBe("connected")
        expect(transportCalls.length).toBe(1)
        expect(transportCalls[0].type).toBe("streamable")
      }),
    {
      config: {
        mcp: {
          "cfg-http-server": {
            type: "http" as const,
            url: "https://cfg.example.com/mcp",
          },
        },
      },
    },
  )

  // ── Disconnect on nonexistent server ──

  it.instance(
    "disconnect on nonexistent http server throws NotFoundError",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const exit = yield* mcp.disconnect("nonexistent").pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toMatchObject({
            _tag: "MCP.NotFoundError",
            name: "nonexistent",
          })
        }
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "connect on nonexistent http server throws NotFoundError",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        const exit = yield* mcp.connect("nonexistent").pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    { config: { mcp: {} } },
  )

  // ── Mixed server types ──

  it.instance(
    "http and local servers coexist",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.add("mixed-http", { type: "http", url: "https://example.com/mcp" })
        yield* mcp.add("mixed-local", { type: "local", command: ["echo", "test"] })

        const status = yield* mcp.status()
        expect(status["mixed-http"]?.status).toBe("connected")
        expect(status["mixed-local"]?.status).toBe("connected")
      }),
    { config: { mcp: {} } },
  )
})
