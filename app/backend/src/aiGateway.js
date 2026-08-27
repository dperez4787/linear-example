// The AI Gateway client: the ONE module through which every model call flows
// (DAN-48). The backend never holds a provider API key — requests go to the
// team's AI gateway with the gateway's own bearer key, and the gateway holds
// the provider credentials. No OpenAI/Anthropic SDK, no provider key, ever.
//
// Seam pattern (docs/architecture.md, Authentication — same shape as verifyToken):
// createApp({ aiGateway }) injects an instance built here; resolvers reach it
// through the GraphQL context and never construct their own client. Tests build
// one with an injected fetch/transport, so no test performs a real network call.
//
// Env contract (DAN-48 criterion 3): AI_GATEWAY_URL and AI_GATEWAY_KEY are read
// LAZILY, inside chat(), never at import or factory time — the server must boot
// and /health must return 200 with neither set, exactly like the no-.env path.
import { recordUsage as defaultRecordUsage } from './aiUsage.js'

// The gateway said no more quota for this caller (HTTP 429). Mapped by the
// GraphQL error mapper to extensions.code 'QUOTA_EXHAUSTED' with this
// human-readable message — the one gateway failure the client is told about.
export class QuotaExhaustedError extends Error {
  constructor(message = 'AI quota exhausted — try again later.') {
    super(message)
    this.name = 'QuotaExhaustedError'
    this.status = 429
  }
}

// Any other gateway failure: non-2xx response, network error, or missing
// configuration. Deliberately NOT given a mapper branch — it falls through to
// the INTERNAL branch, which logs the real error server-side (console.error)
// and returns a generic message, so gateway details never leak to the client.
export class GatewayError extends Error {
  constructor(message) {
    super(message)
    this.name = 'GatewayError'
  }
}

// Factory. `fetch` is the injectable transport (tests capture the request with a
// stub; production uses the global). `recordUsage` is injectable for the same
// reason — the gateway unit tests must not need a Mongo connection.
export function createAiGateway({
  fetch: fetchImpl = globalThis.fetch,
  recordUsage = defaultRecordUsage,
} = {}) {
  // One chat completion on behalf of a signed-in user. `uid`, `promptId`, and
  // `role` become the gateway's attribution metadata; every other field (model,
  // messages, …) passes through as the request body, so the caller owns the
  // conversational payload and this module owns transport, attribution, error
  // typing, and usage recording.
  async function chat({ uid, promptId, role, ...request }) {
    // Lazy env read — load-bearing, see the module comment. Missing config is a
    // GatewayError (→ INTERNAL, logged server-side), never a boot-time failure.
    const url = process.env.AI_GATEWAY_URL
    const key = process.env.AI_GATEWAY_KEY
    if (!url || !key) {
      throw new GatewayError('AI gateway is not configured: AI_GATEWAY_URL and AI_GATEWAY_KEY must be set')
    }

    let res
    try {
      res = await fetchImpl(`${url}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          ...request,
          metadata: {
            on_behalf_of: uid,
            feature: 'prompt-a-feature',
            prompt_id: promptId,
            role,
          },
        }),
      })
    } catch (err) {
      // Network-level failure. The message is for the server-side log only.
      throw new GatewayError(`AI gateway request failed: ${err.message}`)
    }

    if (res.status === 429) {
      throw new QuotaExhaustedError()
    }
    if (!res.ok) {
      throw new GatewayError(`AI gateway responded ${res.status}`)
    }

    const body = await res.json()

    // Every SUCCESSFUL gateway call increments the caller's ledger: requests + 1,
    // totalTokens += usage.total_tokens. Failed calls (throws above) record nothing.
    await recordUsage(uid, body.usage?.total_tokens ?? 0)

    return body
  }

  return { chat }
}
