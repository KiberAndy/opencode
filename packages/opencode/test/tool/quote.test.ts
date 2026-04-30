import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { Instance } from "../../src/project/instance"
import { QuoteTool, extractTextFromHTML, isBlockedHost, Parameters } from "../../src/tool/quote"
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
  messageID: MessageID.make(""),
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
    Effect.provide(Layer.mergeAll(FetchHttpClient.layer, Truncate.defaultLayer, Agent.defaultLayer)),
    Effect.runPromise,
  )
}

function inInstance<T>(fn: () => Promise<T>) {
  return Instance.provide({ directory: projectRoot, fn })
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

describe("tool.quote execute", () => {
  test("approves a single exact quote and returns match_index", async () => {
    await withFetch(
      () => htmlResponse(html("<p>Привет, мир!</p>")),
      async (url) => {
        await inInstance(async () => {
          const result = await exec({
            url: new URL("/article", url).toString(),
            quotes: { Q1: "Привет, мир!" },
          })
          const data = JSON.parse(result.output)
          expect(data.summary).toEqual({ total: 1, approved: 1, rejected: 0, batch_status: "all" })
          expect(data.results.Q1.status).toBe("approved")
          expect(typeof data.results.Q1.match_index).toBe("number")
          expect(data.results.Q1.match_index).toBeGreaterThanOrEqual(0)
          expect(result.title).toContain("1/1 approved")
        })
      },
    )
  })

  test("approves the maximum of 10 quotes in a single call", async () => {
    const fragments = Array.from({ length: 10 }, (_, i) => `Fragment-${i + 1}`)
    await withFetch(
      () => htmlResponse(html(`<article>${fragments.map((f) => `<p>${f}</p>`).join("")}</article>`)),
      async (url) => {
        await inInstance(async () => {
          const quotes = Object.fromEntries(fragments.map((f, i) => [`Q${i + 1}`, f])) as Args["quotes"]
          const result = await exec({ url: new URL("/all", url).toString(), quotes })
          const data = JSON.parse(result.output)
          expect(data.summary.total).toBe(10)
          expect(data.summary.approved).toBe(10)
          expect(data.summary.batch_status).toBe("all")
          for (let i = 1; i <= 10; i++) {
            expect(data.results[`Q${i}`].status).toBe("approved")
          }
        })
      },
    )
  })

  test("returns partial batch_status when some quotes fail", async () => {
    await withFetch(
      () => htmlResponse(html("<p>alpha</p><p>beta</p>")),
      async (url) => {
        await inInstance(async () => {
          const result = await exec({
            url: new URL("/mixed", url).toString(),
            quotes: { Q1: "alpha", Q2: "GAMMA" },
          })
          const data = JSON.parse(result.output)
          expect(data.summary).toEqual({ total: 2, approved: 1, rejected: 1, batch_status: "partial" })
          expect(data.results.Q1.status).toBe("approved")
          expect(data.results.Q2.status).toBe("rejected")
        })
      },
    )
  })

  test("classifies character_mismatch when a single character differs", async () => {
    await withFetch(
      () => htmlResponse(html("<p>Привет, мир!</p>")),
      async (url) => {
        await inInstance(async () => {
          const result = await exec({
            url: new URL("/char", url).toString(),
            quotes: { Q1: "Привет, мир." },
          })
          const data = JSON.parse(result.output)
          expect(data.results.Q1).toEqual({ status: "rejected", reason: "character_mismatch" })
          expect(data.summary.batch_status).toBe("none")
        })
      },
    )
  })

  test("does NOT auto-correct typos on the page", async () => {
    await withFetch(
      () => htmlResponse(html("<p>Опечатка: првиет</p>")),
      async (url) => {
        await inInstance(async () => {
          const result = await exec({
            url: new URL("/typo", url).toString(),
            quotes: {
              Q1: "Опечатка: привет", // the AI corrected the site's typo
              Q2: "Опечатка: првиет", // exact copy of the typo
            },
          })
          const data = JSON.parse(result.output)
          expect(data.results.Q1).toEqual({ status: "rejected", reason: "character_mismatch" })
          expect(data.results.Q2.status).toBe("approved")
        })
      },
    )
  })

  test("classifies whitespace_mismatch for differing spacing", async () => {
    await withFetch(
      () => htmlResponse(html("<p>Тест  с  двумя  пробелами</p>")),
      async (url) => {
        await inInstance(async () => {
          const result = await exec({
            url: new URL("/ws", url).toString(),
            quotes: { Q1: "Тест с двумя пробелами" },
          })
          const data = JSON.parse(result.output)
          expect(data.results.Q1).toEqual({ status: "rejected", reason: "whitespace_mismatch" })
        })
      },
    )
  })

  test("classifies whitespace_mismatch when newline differs from space", async () => {
    await withFetch(
      () => htmlResponse("<p>Hello\nWorld</p>"),
      async (url) => {
        await inInstance(async () => {
          const result = await exec({
            url: new URL("/nl", url).toString(),
            quotes: { Q1: "Hello World" },
          })
          const data = JSON.parse(result.output)
          expect(data.results.Q1).toEqual({ status: "rejected", reason: "whitespace_mismatch" })
        })
      },
    )
  })

  test("classifies case_mismatch when only letter case differs", async () => {
    await withFetch(
      () => htmlResponse(html("<p>Hello World</p>")),
      async (url) => {
        await inInstance(async () => {
          const result = await exec({
            url: new URL("/case", url).toString(),
            quotes: { Q1: "hello world" },
          })
          const data = JSON.parse(result.output)
          expect(data.results.Q1).toEqual({ status: "rejected", reason: "case_mismatch" })
        })
      },
    )
  })

  test("classifies encoding_mismatch when NBSP vs regular space differ", async () => {
    await withFetch(
      () => htmlResponse(html("<p>Foo&nbsp;Bar</p>")),
      async (url) => {
        await inInstance(async () => {
          const result = await exec({
            url: new URL("/nbsp", url).toString(),
            quotes: { Q1: "Foo Bar" },
          })
          const data = JSON.parse(result.output)
          expect(data.results.Q1).toEqual({ status: "rejected", reason: "encoding_mismatch" })
        })
      },
    )
  })

  test("approves when the quote contains the same NBSP as the page", async () => {
    await withFetch(
      () => htmlResponse(html("<p>Foo&nbsp;Bar</p>")),
      async (url) => {
        await inInstance(async () => {
          const result = await exec({
            url: new URL("/nbsp-exact", url).toString(),
            quotes: { Q1: "Foo\u00A0Bar" },
          })
          const data = JSON.parse(result.output)
          expect(data.results.Q1.status).toBe("approved")
        })
      },
    )
  })

  test("classifies not_found when the quote is completely absent", async () => {
    await withFetch(
      () => htmlResponse(html("<p>some unrelated content</p>")),
      async (url) => {
        await inInstance(async () => {
          const result = await exec({
            url: new URL("/missing", url).toString(),
            quotes: { Q1: "XYZABC-never-appears" },
          })
          const data = JSON.parse(result.output)
          expect(data.results.Q1).toEqual({ status: "rejected", reason: "not_found" })
        })
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
        await inInstance(async () => {
          const result = await exec({
            url: new URL("/hidden", url).toString(),
            quotes: {
              Q1: "hidden in js",
              Q2: "visible body",
            },
          })
          const data = JSON.parse(result.output)
          expect(data.results.Q1).toEqual({ status: "rejected", reason: "not_found" })
          expect(data.results.Q2.status).toBe("approved")
        })
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
        await inInstance(async () => {
          const result = await exec({
            url: new URL("/plain.txt", url).toString(),
            quotes: { Q1: "raw plain text body" },
          })
          const data = JSON.parse(result.output)
          expect(data.results.Q1.status).toBe("approved")
        })
      },
    )
  })

  test("rejects zero quotes via the schema", async () => {
    await expect(
      inInstance(() => exec({ url: "https://example.com/", quotes: {} as Args["quotes"] })),
    ).rejects.toBeDefined()
  })

  test("rejects empty-string quote values via the schema", async () => {
    await expect(
      inInstance(() => exec({ url: "https://example.com/", quotes: { Q1: "" } as Args["quotes"] })),
    ).rejects.toBeDefined()
  })

  test("rejects non-http(s) URLs", async () => {
    await expect(
      inInstance(() => exec({ url: "file:///etc/passwd", quotes: { Q1: "root" } })),
    ).rejects.toBeDefined()
    await expect(
      inInstance(() => exec({ url: "data:text/plain,hello", quotes: { Q1: "hello" } })),
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
        inInstance(() => exec({ url: "http://localhost:8080/", quotes: { Q1: "x" } })),
      ).rejects.toBeDefined()
      await expect(
        inInstance(() => exec({ url: "http://10.0.0.1/", quotes: { Q1: "x" } })),
      ).rejects.toBeDefined()
      await expect(
        inInstance(() => exec({ url: "http://169.254.169.254/", quotes: { Q1: "x" } })),
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
        await inInstance(async () => {
          await expect(
            exec({ url: new URL("/big", url).toString(), quotes: { Q1: "AAAA" } }),
          ).rejects.toBeDefined()
        })
      },
    )
  })
})
