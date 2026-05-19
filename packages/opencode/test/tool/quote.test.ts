import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { provideInstance } from "../fixture/fixture"
import { InstanceRef } from "../../src/effect/instance-ref"
import {
  QuoteTool,
  buildResponse,
  collectQuotes,
  extractTextFromHTML,
  isBlockedHost,
  Parameters,
  renderQuoteLines,
  validateQuotesInput,
} from "../../src/tool/quote"
import { SessionID, MessageID } from "../../src/session/schema"
import type { Tool } from "@/tool/tool"

const projectRoot = path.join(import.meta.dir, "../..")

const PRIVATE_HOSTS_ENV = "OPENCODE_QUOTE_ALLOW_PRIVATE_HOSTS"
const previousPrivateHosts = process.env[PRIVATE_HOSTS_ENV]

beforeAll(() => {
  process.env[PRIVATE_HOSTS_ENV] = "1"
})

afterAll(() => {
  if (previousPrivateHosts === undefined) delete process.env[PRIVATE_HOSTS_ENV]
  else process.env[PRIVATE_HOSTS_ENV] = previousPrivateHosts
})

const ctx = {
  sessionID: SessionID.make("ses_test-quote"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

type Args = typeof Parameters.Type

async function withFetch(fetch: (req: Request) => Response | Promise<Response>, fn: (url: URL) => Promise<void>) {
  using server = Bun.serve({ port: 0, fetch })
  await fn(server.url)
}

function exec(args: Args) {
  return QuoteTool.pipe(
    Effect.flatMap((info) => info.init()),
    Effect.flatMap((tool) => tool.execute(args, ctx as Tool.Context)),
    Effect.provide(
      Layer.mergeAll(
        FetchHttpClient.layer,
        Truncate.defaultLayer,
        Agent.defaultLayer,
      ),
    ),
  )
}

function execInInstance(args: Args) {
  return Effect.runPromise(
    provideInstance(projectRoot)(
      exec(args)
    )
  )
}

function html(body: string) {
  return `<!doctype html><html><body>${body}</body></html>`
}

function htmlResponse(body: string) {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  })
}

describe("tool.quote extractTextFromHTML", () => {
  test("strips scripts, styles and comments", () => {
    const out = extractTextFromHTML(
      `<!doctype html><html><head><style>body{color:red}</style></head><body>Hello<!-- ignore --><script>alert(1)</script> World</body></html>`,
    )
    expect(out).toBe("Hello World")
  })

  test("preserves exact whitespace between text nodes", () => {
    const out = extractTextFromHTML(`<p>One  two</p><p>three\nfour</p>`)
    expect(out).toBe("One  twothree\nfour")
  })

  test("decodes common HTML entities including nbsp", () => {
    const out = extractTextFromHTML(`<p>A&nbsp;B &amp; C &#x2014; D &#8212;</p>`)
    expect(out).toBe("A\u00A0B & C \u2014 D \u2014")
  })
})

describe("tool.quote buildResponse / collectQuotes", () => {
  const url = "https://example.com/article"

  test("collectQuotes preserves Q1..Q10 ordering and skips undefined slots", () => {
    const entries = collectQuotes({ Q3: "third", Q1: "first", Q5: "fifth" })
    expect(entries).toEqual([
      ["Q1", "first"],
      ["Q3", "third"],
      ["Q5", "fifth"],
    ])
  })

  test("buildResponse classifies each entry and reports `all` when every quote is approved", () => {
    const entries = collectQuotes({ Q1: "alpha", Q2: "beta" })
    const response = buildResponse(url, entries, "alpha and beta on the page")
    expect(response.summary).toEqual({ total: 2, approved: 2, rejected: 0, batch_status: "all" })
    expect(response.results).toEqual({
      Q1: { status: "approved", match_index: 0 },
      Q2: { status: "approved", match_index: 10 },
    })
  })

  test("buildResponse reports `partial` when some quotes fail and `none` when all fail", () => {
    const entries = collectQuotes({ Q1: "alpha", Q2: "delta" })
    const partial = buildResponse(url, entries, "alpha and beta on the page")
    expect(partial.summary).toEqual({ total: 2, approved: 1, rejected: 1, batch_status: "partial" })
    expect(partial.results.Q2).toEqual({ status: "rejected", reason: "not_found" })

    const none = buildResponse(url, entries, "unrelated content here")
    expect(none.summary).toEqual({ total: 2, approved: 0, rejected: 2, batch_status: "none" })
  })
})

describe("tool.quote validateQuotesInput", () => {
  test("accepts a sparse subset of Q1..Q10 in any input order", () => {
    const entries = validateQuotesInput({ Q3: "c", Q1: "a", Q10: "j" })
    expect(entries).toEqual([
      ["Q1", "a"],
      ["Q3", "c"],
      ["Q10", "j"],
    ])
  })

  test("rejects empty payload", () => {
    expect(() => validateQuotesInput({})).toThrow(/at least 1 entry/i)
  })

  test("rejects payloads with more than 10 entries", () => {
    const quotes = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`Q${i + 1}`, `q${i}`]))
    expect(() => validateQuotesInput(quotes)).toThrow(/at most 10 entries/i)
  })

  test("rejects unknown keys outside Q1..Q10", () => {
    expect(() => validateQuotesInput({ Q11: "x" })).toThrow(/unknown keys: Q11/)
    expect(() => validateQuotesInput({ Q0: "x" })).toThrow(/unknown keys: Q0/)
    expect(() => validateQuotesInput({ A1: "x" })).toThrow(/unknown keys: A1/)
    expect(() => validateQuotesInput({ "Q1.5": "x" })).toThrow(/unknown keys: Q1\.5/)
    expect(() => validateQuotesInput({ Q1: "ok", Q11: "bad", Q12: "bad" })).toThrow(/Q11, Q12/)
  })

  test("rejects empty-string values", () => {
    expect(() => validateQuotesInput({ Q1: "" })).toThrow(/non-empty/i)
  })

  test("rejects whitespace-only values (spaces, tabs, newlines)", () => {
    expect(() => validateQuotesInput({ Q1: "   " })).toThrow(/non-whitespace/i)
    expect(() => validateQuotesInput({ Q1: "\n\t " })).toThrow(/non-whitespace/i)
    expect(() => validateQuotesInput({ Q1: "\u00A0\u00A0" })).toThrow(/non-whitespace/i)
  })

  test("does not silently drop Q11 when valid Q1..Q10 are also present", () => {
    const quotes = Object.fromEntries([
      ...Array.from({ length: 10 }, (_, i) => [`Q${i + 1}`, `q${i}`]),
      ["Q11", "extra"],
    ])
    expect(() => validateQuotesInput(quotes)).toThrow(/at most 10 entries.*got 11/i)
  })
})

describe("tool.quote renderQuoteLines", () => {
  test("renders approved quotes as `| <text>`", () => {
    const lines = renderQuoteLines({ Q1: "Hello world" }, { Q1: { status: "approved", match_index: 0 } })
    expect(lines).toEqual(["| Hello world"])
  })

  test("annotates rejected quotes with the rejection reason", () => {
    const lines = renderQuoteLines(
      { Q1: "Hello", Q2: "World" },
      {
        Q1: { status: "approved", match_index: 0 },
        Q2: { status: "rejected", reason: "case_mismatch" },
      },
    )
    expect(lines).toEqual(["| Hello", "| World (rejected: case_mismatch)"])
  })

  test("preserves Q1..Q10 ordering regardless of input key order", () => {
    const lines = renderQuoteLines(
      { Q3: "third", Q1: "first", Q5: "fifth" },
      {
        Q1: { status: "approved", match_index: 0 },
        Q3: { status: "approved", match_index: 5 },
        Q5: { status: "approved", match_index: 10 },
      },
    )
    expect(lines).toEqual(["| first", "| third", "| fifth"])
  })

  test("collapses newlines so each quote stays on a single visual line", () => {
    const lines = renderQuoteLines(
      { Q1: "first line\nsecond line" },
      { Q1: { status: "approved", match_index: 0 } },
    )
    expect(lines).toEqual(["| first line second line"])
  })

  test("renders quotes with no available results as approved (pre-completion view)", () => {
    const lines = renderQuoteLines({ Q1: "alpha", Q2: "beta" }, undefined)
    expect(lines).toEqual(["| alpha", "| beta"])
  })

  test("skips empty and missing slots", () => {
    const lines = renderQuoteLines({ Q1: "alpha", Q2: "", Q3: undefined } as never, undefined)
    expect(lines).toEqual(["| alpha"])
  })

  test("returns an empty list when no quotes are provided", () => {
    expect(renderQuoteLines(undefined, undefined)).toEqual([])
    expect(renderQuoteLines({}, {})).toEqual([])
  })
})

describe("tool.quote execute", () => {
  test("approves a single exact quote and returns match_index", async () => {
    await withFetch(
      () => htmlResponse(html("<p>Привет, мир!</p>")),
      async (url) => {
        const result = await execInInstance({
          url: new URL("/article", url).toString(),
          quotes: { Q1: "Привет, мир!" },
        })
        const data = JSON.parse(result.output)
        expect(data.summary).toEqual({ total: 1, approved: 1, rejected: 0, batch_status: "all" })
        expect(data.results.Q1.status).toBe("approved")
        expect(typeof data.results.Q1.match_index).toBe("number")
        expect(data.results.Q1.match_index).toBeGreaterThanOrEqual(0)
        expect(result.title).toContain("1/1 approved")
      },
    )
  })

  test("approves the maximum of 10 quotes in a single call", async () => {
    const fragments = Array.from({ length: 10 }, (_, i) => `Fragment-${i + 1}`)
    await withFetch(
      () => htmlResponse(html(`<article>${fragments.map((f) => `<p>${f}</p>`).join("")}</article>`)),
      async (url) => {
        const quotes = Object.fromEntries(fragments.map((f, i) => [`Q${i + 1}`, f])) as Args["quotes"]
        const result = await execInInstance({ url: new URL("/all", url).toString(), quotes })
        const data = JSON.parse(result.output)
        expect(data.summary.total).toBe(10)
        expect(data.summary.approved).toBe(10)
        expect(data.summary.batch_status).toBe("all")
        for (let i = 1; i <= 10; i++) {
          expect(data.results[`Q${i}`].status).toBe("approved")
        }
      },
    )
  })

  test("returns partial batch_status when some quotes fail", async () => {
    await withFetch(
      () => htmlResponse(html("<p>alpha</p><p>beta</p>")),
      async (url) => {
        const result = await execInInstance({
          url: new URL("/mixed", url).toString(),
          quotes: { Q1: "alpha", Q2: "GAMMA" },
        })
        const data = JSON.parse(result.output)
        expect(data.summary).toEqual({ total: 2, approved: 1, rejected: 1, batch_status: "partial" })
        expect(data.results.Q1.status).toBe("approved")
        expect(data.results.Q2.status).toBe("rejected")
      },
    )
  })

  test("classifies character_mismatch when a single character differs", async () => {
    await withFetch(
      () => htmlResponse(html("<p>Привет, мир!</p>")),
      async (url) => {
        const result = await execInInstance({
          url: new URL("/char", url).toString(),
          quotes: { Q1: "Привет, мир." },
        })
        const data = JSON.parse(result.output)
        expect(data.results.Q1).toEqual({ status: "rejected", reason: "character_mismatch" })
        expect(data.summary.batch_status).toBe("none")
      },
    )
  })

  test("does NOT auto-correct typos on the page", async () => {
    await withFetch(
      () => htmlResponse(html("<p>Опечатка: првиет</p>")),
      async (url) => {
        const result = await execInInstance({
          url: new URL("/typo", url).toString(),
          quotes: {
            Q1: "Опечатка: привет",
            Q2: "Опечатка: првиет",
          },
        })
        const data = JSON.parse(result.output)
        expect(data.results.Q1).toEqual({ status: "rejected", reason: "character_mismatch" })
        expect(data.results.Q2.status).toBe("approved")
      },
    )
  })

  test("classifies whitespace_mismatch for differing spacing", async () => {
    await withFetch(
      () => htmlResponse(html("<p>Тест  с  двумя  пробелами</p>")),
      async (url) => {
        const result = await execInInstance({
          url: new URL("/ws", url).toString(),
          quotes: { Q1: "Тест с двумя пробелами" },
        })
        const data = JSON.parse(result.output)
        expect(data.results.Q1).toEqual({ status: "rejected", reason: "whitespace_mismatch" })
      },
    )
  })

  test("classifies whitespace_mismatch when newline differs from space", async () => {
    await withFetch(
      () => htmlResponse("<p>Hello\nWorld</p>"),
      async (url) => {
        const result = await execInInstance({
          url: new URL("/nl", url).toString(),
          quotes: { Q1: "Hello World" },
        })
        const data = JSON.parse(result.output)
        expect(data.results.Q1).toEqual({ status: "rejected", reason: "whitespace_mismatch" })
      },
    )
  })

  test("classifies case_mismatch when only letter case differs", async () => {
    await withFetch(
      () => htmlResponse(html("<p>Hello World</p>")),
      async (url) => {
        const result = await execInInstance({
          url: new URL("/case", url).toString(),
          quotes: { Q1: "hello world" },
        })
        const data = JSON.parse(result.output)
        expect(data.results.Q1).toEqual({ status: "rejected", reason: "case_mismatch" })
      },
    )
  })

  test("classifies encoding_mismatch when NBSP vs regular space differ", async () => {
    await withFetch(
      () => htmlResponse(html("<p>Foo&nbsp;Bar</p>")),
      async (url) => {
        const result = await execInInstance({
          url: new URL("/nbsp", url).toString(),
          quotes: { Q1: "Foo Bar" },
        })
        const data = JSON.parse(result.output)
        expect(data.results.Q1).toEqual({ status: "rejected", reason: "encoding_mismatch" })
      },
    )
  })

  test("approves when the quote contains the same NBSP as the page", async () => {
    await withFetch(
      () => htmlResponse(html("<p>Foo&nbsp;Bar</p>")),
      async (url) => {
        const result = await execInInstance({
          url: new URL("/nbsp-exact", url).toString(),
          quotes: { Q1: "Foo\u00A0Bar" },
        })
        const data = JSON.parse(result.output)
        expect(data.results.Q1.status).toBe("approved")
      },
    )
  })

  test("classifies not_found when the quote is completely absent", async () => {
    await withFetch(
      () => htmlResponse(html("<p>some unrelated content</p>")),
      async (url) => {
        const result = await execInInstance({
          url: new URL("/missing", url).toString(),
          quotes: { Q1: "XYZABC-never-appears" },
        })
        const data = JSON.parse(result.output)
        expect(data.results.Q1).toEqual({ status: "rejected", reason: "not_found" })
      },
    )
  })

  test("ignores content inside <script> and <style> tags", async () => {
    await withFetch(
      () =>
        htmlResponse(
          `<!doctype html><html><head><style>.x{}</style><script>const SECRET = "hidden in js"</script></head><body><p>visible body</p></body></html>`,
        ),
      async (url) => {
        const result = await execInInstance({
          url: new URL("/hidden", url).toString(),
          quotes: {
            Q1: "hidden in js",
            Q2: "visible body",
          },
        })
        const data = JSON.parse(result.output)
        expect(data.results.Q1).toEqual({ status: "rejected", reason: "not_found" })
        expect(data.results.Q2.status).toBe("approved")
      },
    )
  })

  test("handles plain text responses without HTML parsing", async () => {
    await withFetch(
      () =>
        new Response("raw plain text body", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      async (url) => {
        const result = await execInInstance({
          url: new URL("/plain.txt", url).toString(),
          quotes: { Q1: "raw plain text body" },
        })
        const data = JSON.parse(result.output)
        expect(data.results.Q1.status).toBe("approved")
      },
    )
  })

  test("rejects zero quotes via the schema", async () => {
    await expect(
      execInInstance({ url: "https://example.com/", quotes: {} as Args["quotes"] }),
    ).rejects.toBeDefined()
  })

  test("rejects empty-string quote values via the schema", async () => {
    await expect(
      execInInstance({ url: "https://example.com/", quotes: { Q1: "" } as Args["quotes"] }),
    ).rejects.toBeDefined()
  })

  test("rejects more than 10 quotes (no silent truncation of Q11+)", async () => {
    const quotes = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`Q${i + 1}`, `frag-${i + 1}`])) as Args["quotes"]
    await expect(
      execInInstance({ url: "https://example.com/", quotes }),
    ).rejects.toThrow(/at most 10 entries/i)
  })

  test("rejects unknown keys like Q0, A1 with a clear error", async () => {
    await expect(
      execInInstance({ url: "https://example.com/", quotes: { Q0: "x" } as unknown as Args["quotes"] }),
    ).rejects.toThrow(/unknown keys/i)
    await expect(
      execInInstance({ url: "https://example.com/", quotes: { A1: "x" } as unknown as Args["quotes"] }),
    ).rejects.toThrow(/unknown keys/i)
  })

  test("rejects whitespace-only quote values", async () => {
    await expect(
      execInInstance({ url: "https://example.com/", quotes: { Q1: "   " } as Args["quotes"] }),
    ).rejects.toThrow(/non-whitespace/i)
    await expect(
      execInInstance({ url: "https://example.com/", quotes: { Q1: "\n\t " } as Args["quotes"] }),
    ).rejects.toThrow(/non-whitespace/i)
  })

  test("rejects non-http(s) URLs", async () => {
    await expect(
      execInInstance({ url: "file:///etc/passwd", quotes: { Q1: "root" } }),
    ).rejects.toBeDefined()
    await expect(
      execInInstance({ url: "data:text/plain,hello", quotes: { Q1: "hello" } }),
    ).rejects.toBeDefined()
  })

  test("isBlockedHost rejects loopback, private and link-local addresses", () => {
    expect(isBlockedHost("localhost")).toBe(true)
    expect(isBlockedHost("foo.localhost")).toBe(true)
    expect(isBlockedHost("127.0.0.1")).toBe(true)
    expect(isBlockedHost("127.1.2.3")).toBe(true)
    expect(isBlockedHost("10.0.0.1")).toBe(true)
    expect(isBlockedHost("172.16.0.1")).toBe(true)
    expect(isBlockedHost("172.31.255.255")).toBe(true)
    expect(isBlockedHost("192.168.1.1")).toBe(true)
    expect(isBlockedHost("169.254.169.254")).toBe(true)
    expect(isBlockedHost("0.0.0.0")).toBe(true)
    expect(isBlockedHost("224.0.0.1")).toBe(true)
    expect(isBlockedHost("::1")).toBe(true)
    expect(isBlockedHost("fe80::1")).toBe(true)
    expect(isBlockedHost("fc00::1")).toBe(true)
    expect(isBlockedHost("[::1]")).toBe(true)
    expect(isBlockedHost("8.8.8.8")).toBe(false)
    expect(isBlockedHost("172.32.0.1")).toBe(false)
    expect(isBlockedHost("example.com")).toBe(false)
    expect(isBlockedHost("2606:4700:4700::1111")).toBe(false)
  })

  test("execute rejects loopback hosts when SSRF guard is active", async () => {
    delete process.env[PRIVATE_HOSTS_ENV]
    try {
      await expect(
        execInInstance({ url: "http://localhost:8080/", quotes: { Q1: "x" } }),
      ).rejects.toBeDefined()
      await expect(
        execInInstance({ url: "http://10.0.0.1/", quotes: { Q1: "x" } }),
      ).rejects.toBeDefined()
      await expect(
        execInInstance({ url: "http://169.254.169.254/", quotes: { Q1: "x" } }),
      ).rejects.toBeDefined()
    } finally {
      process.env[PRIVATE_HOSTS_ENV] = "1"
    }
  })

  test("rejects payloads larger than the 2MB response limit", async () => {
    const large = "A".repeat(3 * 1024 * 1024)
    await withFetch(
      () => htmlResponse(html(`<p>${large}</p>`)),
      async (url) => {
        await expect(
          execInInstance({ url: new URL("/big", url).toString(), quotes: { Q1: "AAAA" } }),
        ).rejects.toBeDefined()
      },
    )
  })
})
