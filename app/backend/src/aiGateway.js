// The AI Gateway client: the ONE module through which every model call flows
// (DAN-48). The backend never holds a provider API key — requests go to the
// team's AI gateway with the gateway's own virtual key, and the gateway holds
// the provider credentials. No OpenAI/Anthropic SDK, no provider key, ever.
//
// Production wiring (DAN-60): the virtual key travels in the `x-gateway-key`
// header — the one and only way this client sends it; there is deliberately no
// Authorization bearer of the virtual key anymore. The Authorization header is
// reserved for the Google-signed IAM identity token: when running on Cloud Run
// (detected via K_SERVICE, escape hatch AI_GATEWAY_IAM=off) the client fetches
// an id token from the metadata server — audience = the AI_GATEWAY_URL origin —
// and sends it as `Authorization: Bearer <token>` so the IAM-protected gateway
// admits the request. Tokens last 60 minutes; we cache one for 50. The metadata
// fetch uses the SAME injectable fetch as the gateway call, so tests never
// touch a network and local runs (no K_SERVICE) never invent an Authorization.
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

// Any other gateway failure: non-2xx response, network error, missing
// configuration, or a failed metadata-server token fetch. Deliberately NOT
// given a mapper branch — it falls through to the INTERNAL branch, which logs
// the real error server-side (console.error) and returns a generic message, so
// gateway details (and the id token itself) never leak to the client.
export class GatewayError extends Error {
  constructor(message) {
    super(message)
    this.name = 'GatewayError'
  }
}

// Google id tokens last 60 minutes; refresh after 50 so a cached token is never
// presented within the final ten minutes of its life.
const ID_TOKEN_TTL_MS = 50 * 60 * 1000

// IAM is on exactly when we are on Cloud Run (K_SERVICE is injected by the
// platform) and the escape hatch has not been pulled. Read lazily per call,
// like every other env read in this module.
function iamEnabled() {
  return Boolean(process.env.K_SERVICE) && process.env.AI_GATEWAY_IAM !== 'off'
}

// Factory. `fetch` is the injectable transport for BOTH the gateway call and
// the metadata-server token fetch (tests capture the requests with a stub;
// production uses the global). `recordUsage` is injectable for the same
// reason — the gateway unit tests must not need a Mongo connection.
export function createAiGateway({
  fetch: fetchImpl = globalThis.fetch,
  recordUsage = defaultRecordUsage,
} = {}) {
  // Per-instance id-token cache: { token, audience, expiresAt }. Per instance,
  // not module-level, so tests get a fresh cache with every createAiGateway().
  let idTokenCache = null

  // Fetch (or reuse) a Google-signed identity token for `audience` from the
  // Cloud Run metadata server. Every failure — network, non-2xx — is a
  // GatewayError, so over the wire it surfaces as the established INTERNAL
  // mapping; the error message never contains the token.
  async function getIdToken(audience) {
    if (idTokenCache && idTokenCache.audience === audience && Date.now() < idTokenCache.expiresAt) {
      return idTokenCache.token
    }
    let res
    try {
      res = await fetchImpl(
        `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`,
        { headers: { 'Metadata-Flavor': 'Google' } },
      )
    } catch (err) {
      // Message is for the server-side log only (INTERNAL never leaks it).
      throw new GatewayError(`metadata server id-token fetch failed: ${err.message}`)
    }
    if (!res.ok) {
      throw new GatewayError(`metadata server responded ${res.status} to the id-token fetch`)
    }
    const token = await res.text()
    idTokenCache = { token, audience, expiresAt: Date.now() + ID_TOKEN_TTL_MS }
    return token
  }

  // The transport preamble every gateway endpoint shares (DAN-80 refactor,
  // no behavior change to chat): the lazy AI_GATEWAY_URL/AI_GATEWAY_KEY read —
  // load-bearing, see the module comment; missing config is a GatewayError
  // (→ INTERNAL, logged server-side), never a boot-time failure — plus the auth
  // headers. The virtual key rides in x-gateway-key — never in Authorization,
  // which belongs to the IAM id token (present only on Cloud Run).
  async function gatewayAuth() {
    const url = process.env.AI_GATEWAY_URL
    const key = process.env.AI_GATEWAY_KEY
    if (!url || !key) {
      throw new GatewayError('AI gateway is not configured: AI_GATEWAY_URL and AI_GATEWAY_KEY must be set')
    }

    const headers = { 'x-gateway-key': key }
    if (iamEnabled()) {
      let audience
      try {
        audience = new URL(url).origin
      } catch {
        throw new GatewayError('AI_GATEWAY_URL is not a valid URL')
      }
      headers.Authorization = `Bearer ${await getIdToken(audience)}`
    }
    return { url, headers }
  }

  // One chat completion on behalf of a signed-in user. `uid`, `promptId`, and
  // `role` become the gateway's attribution metadata; every other field (model,
  // messages, …) passes through as the request body, so the caller owns the
  // conversational payload and this module owns transport, attribution, error
  // typing, and usage recording.
  async function chat({ uid, promptId, role, ...request }) {
    const { url, headers } = await gatewayAuth()
    headers['Content-Type'] = 'application/json'

    let res
    try {
      res = await fetchImpl(`${url}/v1/chat/completions`, {
        method: 'POST',
        headers,
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

  // Read the gateway's usage ledger (DAN-80): GET /v1/usage grouped by the
  // given dimension (e.g. groupBy: 'prompt_id'). Same auth as chat() — the
  // virtual key in x-gateway-key, plus the Cloud Run IAM id token when
  // K_SERVICE is set — through the same injectable fetch, so tests capture the
  // request and no real gateway is ever reached. Every failure (missing
  // config, network, non-2xx) is a GatewayError → the established INTERNAL
  // mapping; the parsed response body is returned as-is and the caller owns
  // filtering/presentation. Reads record nothing against the usage ledger.
  //
  // DAN-107: `window` is the ledger window the gateway aggregates over, and it
  // belongs to the CALLER, because only the caller knows what question it is
  // asking. The gateway's own default is `day` (rows since today's UTC
  // midnight) — right for a quota meter, wrong for "what has this feature cost
  // in total", which is a lifetime question and passes `window: 'all'`
  // (DAN-106 on the gateway side). Omitted here means the parameter is not
  // sent at all, so the gateway's `day` default stands and the wire shape of
  // every pre-DAN-107 caller is byte-for-byte unchanged. Any future per-ticket
  // cost read asks for its own window the same way, at the call site, rather
  // than inheriting one hardcoded in here.
  async function usage({ groupBy, window }) {
    const { url, headers } = await gatewayAuth()

    const query = new URLSearchParams({ group_by: groupBy })
    if (window !== undefined) query.set('window', window)

    let res
    try {
      res = await fetchImpl(`${url}/v1/usage?${query}`, { headers })
    } catch (err) {
      // Network-level failure. The message is for the server-side log only.
      throw new GatewayError(`AI gateway usage request failed: ${err.message}`)
    }

    if (!res.ok) {
      throw new GatewayError(`AI gateway responded ${res.status} to the usage read`)
    }

    return res.json()
  }

  return { chat, usage }
}
