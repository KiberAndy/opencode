import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as Tool from "./tool"
import DESCRIPTION from "./quote.txt"

const MAX_RESPONSE_SIZE = 2 * 1024 * 1024 // 2 MiB
const REQUEST_TIMEOUT = 3 * 1000 // 3 s

export const QUOTE_KEYS = ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7", "Q8", "Q9", "Q10"] as const
export type QuoteKey = (typeof QUOTE_KEYS)[number]
const QUOTE_KEY_SET: ReadonlySet<string> = new Set(QUOTE_KEYS)

// Use Schema.Record so that unknown keys (Q11, A1, etc.) reach `validateQuotesInput`
// instead of being silently stripped by Schema.Struct's default decoding.
const QuotesSchema = Schema.Record(Schema.String, Schema.String)

export const Parameters = Schema.Struct({
  url: Schema.String.annotate({
    description: "URL of the page the quotes must appear on. Must start with http:// or https://.",
  }),
  quotes: QuotesSchema.annotate({
    description:
      "Object with between 1 and 10 entries. Keys MUST be a subset of Q1, Q2, ..., Q10 (no other keys are allowed). Each value MUST be a non-empty string that contains at least one non-whitespace character and appears verbatim on the page.",
  }),
})

export type QuoteResult =
  | { status: "approved"; match_index: number }
  | { status: "rejected"; reason: "not_found" | "character_mismatch" | "whitespace_mismatch" | "case_mismatch" | "encoding_mismatch" }

export type QuoteResponse = {
  url: string
  results: Record<string, QuoteResult>
  summary: {
    total: number
    approved: number
    rejected: number
    batch_status: "all" | "partial" | "none"
  }
}

const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback", "broadcasthost"])

export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "") return true
  if (BLOCKED_HOSTNAMES.has(host)) return true
  if (host.endsWith(".localhost")) return true

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) {
    const a = Number(ipv4[1])
    const b = Number(ipv4[2])
    if (a === 0) return true
    if (a === 10) return true
    if (a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a >= 224) return true // multicast / reserved
    return false
  }

  if (host === "::" || host === "::1") return true
  if (/^fe[89ab][0-9a-f]:/i.test(host)) return true // link-local
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true // unique-local
  return false
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00A0",
  copy: "\u00A9",
  reg: "\u00AE",
  trade: "\u2122",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  laquo: "\u00AB",
  raquo: "\u00BB",
  ldquo: "\u201C",
  rdquo: "\u201D",
  lsquo: "\u2018",
  rsquo: "\u2019",
}

function decodeEntities(input: string): string {
  return input.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (full, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return full
      return String.fromCodePoint(code)
    }
    const mapped = NAMED_ENTITIES[body]
    return mapped ?? full
  })
}

export function extractTextFromHTML(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|template|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<[^>]+>/g, "")
  return decodeEntities(stripped)
}

function normalizeWhitespace(input: string): string {
  return input.replace(/[\s\u00A0\u2028\u2029]+/g, " ").trim()
}

function matchQuote(page: string, quote: string): QuoteResult {
  const idx = page.indexOf(quote)
  if (idx >= 0) return { status: "approved", match_index: idx }

  const pageNfkc = page.normalize("NFKC")
  const quoteNfkc = quote.normalize("NFKC")
  if (page !== pageNfkc || quote !== quoteNfkc) {
    if (pageNfkc.includes(quoteNfkc)) {
      return { status: "rejected", reason: "encoding_mismatch" }
    }
  }

  if (page.toLowerCase().includes(quote.toLowerCase())) {
    return { status: "rejected", reason: "case_mismatch" }
  }

  if (normalizeWhitespace(page).includes(normalizeWhitespace(quote))) {
    return { status: "rejected", reason: "whitespace_mismatch" }
  }

  const probeLen = Math.min(quote.length, 10)
  if (probeLen >= 3 && page.includes(quote.slice(0, probeLen))) {
    return { status: "rejected", reason: "character_mismatch" }
  }

  return { status: "rejected", reason: "not_found" }
}

export function collectQuotes(quotes: Record<string, string>): Array<[QuoteKey, string]> {
  return QUOTE_KEYS.flatMap((key) => {
    const value = quotes[key]
    return value === undefined ? [] : ([[key, value]] as Array<[QuoteKey, string]>)
  })
}

/**
 * Validate the raw `quotes` payload coming from the LLM. Rejects:
 * - Empty payloads and payloads with more than 10 entries.
 * - Unknown keys (anything outside Q1..Q10) so Q11/QA1/A1/Q0 surface a clear
 *   error instead of being silently dropped by the schema decoder.
 * - Empty-string values and whitespace-only values that would otherwise match
 *   trivially against any page containing a single space.
 *
 * Returns the same `[QuoteKey, string]` entries as `collectQuotes` on success.
 */
export function validateQuotesInput(quotes: Record<string, string>): Array<[QuoteKey, string]> {
  const keys = Object.keys(quotes)
  if (keys.length === 0) throw new Error("quotes must contain at least 1 entry (Q1..Q10)")
  if (keys.length > 10) throw new Error(`quotes must contain at most 10 entries (Q1..Q10), got ${keys.length}`)

  const unknown = keys.filter((k) => !QUOTE_KEY_SET.has(k))
  if (unknown.length > 0) {
    throw new Error(`quotes object contains unknown keys: ${unknown.join(", ")} (allowed keys are Q1..Q10)`)
  }

  const empty = keys.filter((k) => quotes[k]!.length === 0)
  if (empty.length > 0) throw new Error(`quote values must be non-empty strings (offending keys: ${empty.join(", ")})`)

  const blank = keys.filter((k) => quotes[k]!.trim().length === 0)
  if (blank.length > 0) {
    throw new Error(
      `quote values must contain at least one non-whitespace character (offending keys: ${blank.join(", ")})`,
    )
  }

  return collectQuotes(quotes)
}

export function buildResponse(url: string, entries: Array<[QuoteKey, string]>, pageText: string): QuoteResponse {
  const matched = entries.map(([key, quote]) => [key, matchQuote(pageText, quote)] as const)
  const results = Object.fromEntries(matched)
  const total = matched.length
  const approved = matched.filter(([, r]) => r.status === "approved").length
  const rejected = total - approved
  const batch_status: "all" | "partial" | "none" = approved === total ? "all" : approved === 0 ? "none" : "partial"
  return { url, results, summary: { total, approved, rejected, batch_status } }
}

/**
 * Build the per-quote lines used by the CLI and TUI renderers. Each entry is
 * rendered as `| <text>` for approved quotes and `| <text> (rejected: <reason>)`
 * for rejected ones, in stable Q1..Q10 order. Newlines inside a quote are
 * collapsed so each quote stays on a single visual line.
 */
export function renderQuoteLines(
  quotes: Record<string, string | undefined> | undefined,
  results: Record<string, QuoteResult> | undefined,
): string[] {
  if (!quotes) return []
  return QUOTE_KEYS.flatMap((key) => {
    const text = quotes[key]
    if (typeof text !== "string" || text.length === 0) return []
    const safe = text.replace(/\r?\n/g, " ")
    const result = results?.[key]
    if (!result || result.status === "approved") return [`| ${safe}`]
    return [`| ${safe} (rejected: ${result.reason})`]
  })
}

export const QuoteTool = Tool.define(
  "quote",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(http)

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const entries = validateQuotesInput(params.quotes)

          const parsed = yield* Effect.try({
            try: () => new URL(params.url),
            catch: () => new Error(`Invalid URL: ${params.url}`),
          })
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new Error("URL must use http:// or https://")
          }
          if (process.env["OPENCODE_QUOTE_ALLOW_PRIVATE_HOSTS"] !== "1" && isBlockedHost(parsed.hostname)) {
            throw new Error(`URL host is blocked for SSRF protection: ${parsed.hostname}`)
          }

          yield* ctx.ask({
            permission: "webfetch",
            patterns: [parsed.origin + parsed.pathname],
            always: ["*"],
            metadata: { url: params.url, quotes: entries.length },
          })

          const response = yield* httpOk
            .execute(
              HttpClientRequest.get(params.url).pipe(
                HttpClientRequest.setHeaders({
                  "User-Agent": "opencode-quote/1.0",
                  Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
                  "Accept-Language": "en-US,en;q=0.5",
                }),
              ),
            )
            .pipe(
              Effect.timeoutOrElse({
                duration: REQUEST_TIMEOUT,
                orElse: () => Effect.die(new Error("Request timed out")),
              }),
            )

          const contentLengthHeader = response.headers["content-length"]
          if (contentLengthHeader && Number(contentLengthHeader) > MAX_RESPONSE_SIZE) {
            throw new Error("Response too large (exceeds 2MB limit)")
          }

          const buffer = yield* response.arrayBuffer
          if (buffer.byteLength > MAX_RESPONSE_SIZE) {
            throw new Error("Response too large (exceeds 2MB limit)")
          }

          const contentType = (response.headers["content-type"] ?? "").toLowerCase()
          const rawDecoded = new TextDecoder("utf-8").decode(buffer)
          const raw = rawDecoded.charCodeAt(0) === 0xfeff ? rawDecoded.slice(1) : rawDecoded
          const isMarkup = contentType.includes("html") || contentType.includes("xml")
          const pageText = isMarkup ? extractTextFromHTML(raw) : raw

          const result = buildResponse(params.url, entries, pageText)
          const title = `Quote verification: ${params.url} (${result.summary.approved}/${result.summary.total} approved)`
          return {
            title,
            output: JSON.stringify(result, null, 2),
            metadata: { url: result.url, results: result.results, summary: result.summary },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
