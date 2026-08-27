// Data layer for feature-request sessions: every Mongo driver call for the
// `feature_requests` collection lives here, mirroring records.js for the
// `records` collection. GraphQL resolvers call these functions and never touch
// the driver directly (see docs/architecture.md, CLAUDE.md).
//
// Unlike records — which any signed-in user reads and writes — feature-request
// sessions are per-user: every function takes the caller's Firebase `uid`
// (threaded from the auth gate through the GraphQL context, see index.js) and
// scopes every query with it. Another user's session is indistinguishable from
// a nonexistent one: both are a NotFoundError, the same "don't reveal what you
// can't have" principle as the malformed-id-is-a-404 rule in records.js.
import { ObjectId } from 'mongodb'

import { GatewayError } from './aiGateway.js'
import { getDb } from './db.js'
import { NotFoundError } from './records.js'
import { loadRolePrompt, CONVERSATION_ROLES } from './roles.js'
import { ValidationError } from './schema.js'

const COLLECTION = 'feature_requests'

// The models a session may be opened against — the full gateway roster
// (DAN-65), matching what the gateway serves. Validation lives here (not in
// schema.js, which is the Record validation module) but throws the same
// ValidationError class, so the one GraphQL error mapper turns it into the
// same BAD_USER_INPUT + field shape as every record validation failure.
export const FEATURE_REQUEST_MODELS = [
  'claude-opus-5',
  'gpt-5.6-terra',
  'gemini-3.6-flash',
  'gpt-oss-120b',
]

function collection() {
  return getDb().collection(COLLECTION)
}

// Same rule as records.js: a malformed id is a not-found, not a 400 — the
// client shouldn't have to distinguish "no such session" from "that couldn't
// possibly be a session id".
function toObjectId(id) {
  if (!ObjectId.isValid(id)) {
    throw new NotFoundError('feature request not found')
  }
  return new ObjectId(id)
}

// `_id` is serialized to the client as a string `id` (the promptId). The `uid`
// stays server-side: the caller already knows who they are, and the GraphQL
// type doesn't expose it.
function toFeatureRequest({ _id, uid, ...rest }) {
  return { id: _id.toString(), ...rest }
}

// Open a new feature-request session for the caller. Validates the model
// BEFORE touching the driver, so an invalid input never writes anything.
export async function startFeatureRequest(uid, input) {
  const model = input?.model
  if (!FEATURE_REQUEST_MODELS.includes(model)) {
    throw new ValidationError(
      `model must be one of ${FEATURE_REQUEST_MODELS.join(', ')}`,
      'model',
    )
  }

  const doc = {
    uid,
    status: 'gathering',
    model,
    messages: [],
    createdAt: new Date(),
  }

  const { insertedId } = await collection().insertOne(doc)
  return toFeatureRequest({ _id: insertedId, ...doc })
}

// The caller's sessions, newest first. `_id` breaks createdAt ties (two
// sessions started in the same millisecond) deterministically — ObjectIds are
// monotonic per process — so "newest first" is stable and testable.
export async function listFeatureRequests(uid) {
  const docs = await collection()
    .find({ uid })
    .sort({ createdAt: -1, _id: -1 })
    .toArray()
  return docs.map(toFeatureRequest)
}

// Single-session read, scoped to the caller. The uid is part of the filter, so
// another user's session id yields the same NotFoundError as an unknown or
// malformed one.
export async function getFeatureRequest(uid, id) {
  const _id = toObjectId(id)
  const doc = await collection().findOne({ _id, uid })
  if (!doc) {
    throw new NotFoundError('feature request not found')
  }
  return toFeatureRequest(doc)
}

// --- sendFeatureRequestMessage: role orchestration + plan extraction (DAN-49) ---

// The internal planner role. Unlike the conversational roles, its prompt is a
// code constant, not a checked-in markdown file: the output is a machine
// contract (strict JSON the code parses), not a voice anyone tunes. It runs
// after every product-owner + architect exchange; DAN-50 adds the
// entrance-criteria evaluator alongside it as a second internal role.
const PLANNER_ROLE = 'planner'

const PLANNER_PROMPT = `You are the planner for a feature-request conversation between a user, a product owner, and an architect.

Read the transcript and decide whether the conversation has converged enough to draft a ticket plan. Respond with STRICT JSON only — no prose, no markdown fences — in exactly this shape:

{"tickets": [{"key": "T1", "title": "...", "description": "...", "dependsOn": []}]}

Rules:
- "key" is a short stable identifier (T1, T2, ...) unique within the plan.
- "dependsOn" lists the keys of tickets that must land first; use [] when none.
- Only include work the transcript actually agreed on. Never invent scope.
- If the conversation has NOT converged enough to plan, respond with {"tickets": []}.`

// --- entrance-criteria evaluation: three hard gates (DAN-50) ---

// The second internal role, a sibling of the planner: after every exchange a
// cheap-model structured-JSON call evaluates whether the session clears the
// three hard gates that control approvability. Like the planner, its prompt is
// a code constant — machine contract, not tunable voice.
const EVALUATOR_ROLE = 'entrance-criteria'

// The ONE place the cheap model id lives. The evaluator is a judgment call a
// small model handles fine; burning the session's conversation model on it
// would multiply cost for no quality gain. Exported so tests assert the
// captured request against this constant rather than re-hardcoding the id.
export const ENTRANCE_CRITERIA_MODEL = 'claude-haiku-4-5'

// The three gates, in the shape DAN-54's frontend consumes. Order matters only
// for readability; each gate is { pass: Boolean, reason: String }.
export const ENTRANCE_GATES = ['notTooBig', 'notAmbiguous', 'noBlockedDependencies']

const ENTRANCE_CRITERIA_PROMPT = `You are the entrance-criteria evaluator for a feature-request conversation between a user, a product owner, and an architect.

Read the transcript and evaluate three hard gates. Respond with STRICT JSON only — no prose, no markdown fences — in exactly this shape:

{"notTooBig": {"pass": true, "reason": "..."}, "notAmbiguous": {"pass": true, "reason": "..."}, "noBlockedDependencies": {"pass": true, "reason": "..."}}

Gates:
- "notTooBig": the request is scoped small enough to plan as a handful of tickets, not an open-ended program of work.
- "notAmbiguous": the requirements are concrete enough that a developer could start without guessing intent.
- "noBlockedDependencies": nothing the transcript identifies as a prerequisite is unresolved or blocked.

Rules:
- "pass" is a boolean verdict for that gate; "reason" is one short sentence justifying it.
- Judge only what the transcript actually says. When in doubt, fail the gate.`

// --- session title: one snake_case slug per feature request (DAN-90) ---

// The third internal role, a sibling of the planner and the evaluator. Like
// them its prompt is a code constant rather than a checked-in roles/*.md file:
// the output is a machine contract (one slug, consumed by code and sanitized
// before use), not a voice anyone tunes. loadRolePrompt() deliberately refuses
// names outside CONVERSATION_ROLES, so this role has no file to load.
const TITLER_ROLE = 'titler'

// The titler's dedicated model, the exact pattern of PLANNER_MODEL and
// ENTRANCE_CRITERIA_MODEL: naming a request in five words is not work that
// needs the session's conversation model, and approval should not get more
// expensive because the user chose opus. The ONE place this id lives;
// exported so tests assert the captured request against the constant.
export const TITLE_MODEL = 'claude-haiku-4-5'

// The slug shape the whole feature is defined by: lowercase alphanumeric words
// joined by single underscores, no leading/trailing/doubled underscores. Every
// persisted title matches this — sanitizeTitle returns null rather than
// anything that does not — so `title` on the wire is either null or a slug,
// never a half-cleaned model artifact.
export const TITLE_PATTERN = /^[a-z0-9]+(_[a-z0-9]+)*$/
export const TITLE_MAX_WORDS = 5
export const TITLE_MAX_CHARS = 50

const TITLE_PROMPT = `You name feature-request sessions. Read the transcript and reply with ONE short snake_case slug naming the change the user is asking for.

Rules:
- Respond with the slug and NOTHING else: no prose, no explanation, no quotes, no markdown, no code fences, no label, no trailing punctuation.
- Use lowercase ASCII letters and digits only, with words joined by single underscores. Example: change_buttons_to_green
- At most 5 words and at most 50 characters.
- Name the change being requested, not the conversation about it.`

// Explicit output budget per role (DAN-69). Without max_tokens the gateway
// falls back to its provider default (anthropic: 1024), which truncated
// architect replies mid-sentence in the live dry-run. The ONE place these
// budgets live; exported so tests assert the captured requests against the
// constants rather than re-hardcoding the numbers.
//
// Trimmed in DAN-72: a full opus round under DAN-69's 3000/3000/1500/500
// budgets measured ~75s, past Firebase Hosting's hard 60s rewrite timeout —
// the client got a 502 while the backend finished, and the retry duplicated
// the message. The conversational budgets drop to 1500 each; the planner's
// RISES to 2500 (a converged live plan was truncated at exactly its old
// 1500 cap, which silently blocked approval) — affordable because DAN-72
// also moves the planner onto the cheap model (see PLANNER_MODEL below),
// which emits its budget in seconds. Worst case stays inside the timeout.
export const MAX_TOKENS_BY_ROLE = {
  'product-owner': 1500,
  architect: 1500,
  [PLANNER_ROLE]: 2500,
  [EVALUATOR_ROLE]: 500,
  // DAN-90: the titler emits one short slug and nothing else. 40 tokens is
  // several times the longest legal answer (5 words / 50 chars), so a
  // well-behaved reply is never truncated, while a model that ignores the
  // "slug only" instruction and starts rambling is cut off cheaply — the
  // sanitizer then salvages a slug from the fragment or falls back.
  [TITLER_ROLE]: 40,
}

// The planner's dedicated model (DAN-72), the exact pattern of
// ENTRANCE_CRITERIA_MODEL below: the planner's output is a machine contract
// (strict JSON), not tunable voice, so a small model handles it fine — and
// unlike the session's conversation model it emits the full 2500-token budget
// in seconds, which is what keeps the whole round under Hosting's 60s rewrite
// timeout. The ONE place this id lives; exported so tests assert the captured
// request against the constant.
export const PLANNER_MODEL = 'claude-haiku-4-5'

// --- lenient JSON extraction for the internal roles (DAN-69) ---

// The first balanced {...} object in `text`, string-aware (braces inside JSON
// strings don't count), or null when none closes.
function firstBalancedObject(text) {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

// Leniently extract the one JSON object from an internal role's reply, or null
// when there is none. Both internal roles are prompted for strict JSON, but in
// the live dry-run claude-haiku wrapped its (valid) JSON in markdown fences and
// the strict JSON.parse rejected it, sticking the gates at "evaluation
// unavailable". Shared by the planner and the evaluator: strip whitespace;
// unwrap a markdown fence (```json ... ``` or ``` ... ```, a preamble before it
// tolerated); otherwise take the first balanced {...} object in the text (which
// tolerates a prose preamble before bare JSON); JSON.parse the result.
// Genuinely malformed content still returns null — each caller's existing
// failure handling is unchanged.
function extractJsonObject(content) {
  if (typeof content !== 'string') return null
  let text = content.trim()
  const fence = text.match(/```(?:json)?\s*\r?\n?([\s\S]*?)```/i)
  if (fence) text = fence[1].trim()
  if (!(text.startsWith('{') && text.endsWith('}'))) {
    const balanced = firstBalancedObject(text)
    if (balanced === null) return null
    text = balanced
  }
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// All three gates failed with one shared reason — the shape stored when the
// evaluation itself could not produce a verdict.
function failedEntranceCriteria(reason) {
  return Object.fromEntries(
    ENTRANCE_GATES.map((gate) => [gate, { pass: false, reason }]),
  )
}

// What a session that has never been evaluated exposes: all gates failed,
// "not yet evaluated". Synthesized at the presentation layer (graphql.js) for
// virgin sessions — never stored, so a stored entranceCriteria always came
// from a real evaluation attempt.
export function unevaluatedEntranceCriteria() {
  return failedEntranceCriteria('not yet evaluated')
}

// All three hard gates pass. Split out of isApprovable (DAN-75) because the
// approve mutation still reports gate failures separately (naming the failing
// gates) before its no-plan backstop.
function allGatesPass(entranceCriteria) {
  return ENTRANCE_GATES.every((gate) => entranceCriteria[gate]?.pass === true)
}

// A stored planner plan with at least one ticket — the thing approval files.
// The ONE definition of "has a plan", shared by isApprovable and the approve
// mutation's backstop, so the two can never disagree.
export function hasStoredPlan(plan) {
  return (plan?.tickets?.length ?? 0) > 0
}

// A session is approvable iff every gate passes AND a plan is stored (DAN-75).
// The UI's Approve button enables off this bit, and approveFeatureRequestPlan
// refuses without a stored plan — so approvable must never promise what the
// mutation would refuse: gates can pass before the planner converges, and such
// a session is NOT approvable yet. Derived, never stored — a derived value
// cannot drift from the state it summarizes.
export function isApprovable(entranceCriteria, plan) {
  return allGatesPass(entranceCriteria) && hasStoredPlan(plan)
}

// Parse and validate the evaluator's reply, or null when it is unusable. Same
// defensive posture as parsePlan: rebuild field-by-field so whatever else the
// model emitted never reaches the database, and any missing or mistyped gate
// invalidates the whole reply — three hard gates, no partial credit.
function parseEntranceCriteria(content) {
  const parsed = extractJsonObject(content)
  if (parsed === null) return null
  const clean = {}
  for (const gate of ENTRANCE_GATES) {
    const verdict = parsed?.[gate]
    if (typeof verdict?.pass !== 'boolean' || typeof verdict?.reason !== 'string') {
      return null
    }
    clean[gate] = { pass: verdict.pass, reason: verdict.reason }
  }
  return clean
}

// A transcript message with usable content. New writes can no longer produce
// an empty turn (DAN-68 — see the guard in sendFeatureRequestMessage), but a
// session corrupted BEFORE that guard may still carry one, and replaying it to
// the gateway 400s every subsequent send — the session wedges permanently.
// Outbound history builders skip such messages so a legacy session self-heals.
function hasContent({ content }) {
  return typeof content === 'string' && content.trim() !== ''
}

// Map the persisted transcript into the chat shape one role's gateway call
// expects. The calling role sees its own prior turns as `assistant`; the user's
// turns are `user`; the OTHER agent's turns are also `user`, prefixed with
// their name so attribution survives the two-party chat format. Empty-content
// messages (legacy corruption, see hasContent) are skipped, never sent.
function toChatMessages(transcript, selfRole) {
  return transcript.filter(hasContent).map(({ role, content }) => {
    if (role === selfRole) return { role: 'assistant', content }
    if (role === 'user') return { role: 'user', content }
    return { role: 'user', content: `[${role}] ${content}` }
  })
}

// Flatten the transcript for an internal analyst role (planner, evaluator):
// the whole conversation is a single user message, because those roles analyze
// the exchange rather than participate in it. Same skip rule as toChatMessages:
// an empty legacy message is noise ("architect: "), not signal.
function transcriptAsText(transcript) {
  return transcript
    .filter(hasContent)
    .map(({ role, content }) => `${role}: ${content}`)
    .join('\n\n')
}

// Parse and validate the planner's reply into a plan, or null when there is no
// (usable) plan. A malformed or empty reply means "not converged yet" — the
// conversation continues and nothing is stored; it is never a client error.
function parsePlan(content) {
  const parsed = extractJsonObject(content)
  if (parsed === null) return null
  const tickets = parsed?.tickets
  if (!Array.isArray(tickets) || tickets.length === 0) return null
  const clean = []
  for (const t of tickets) {
    if (
      typeof t?.key !== 'string' ||
      typeof t?.title !== 'string' ||
      typeof t?.description !== 'string'
    ) {
      return null
    }
    const dependsOn = t.dependsOn ?? []
    if (!Array.isArray(dependsOn) || dependsOn.some((d) => typeof d !== 'string')) {
      return null
    }
    // Rebuild each ticket to exactly the four schema fields — whatever else the
    // model emitted never reaches the database.
    clean.push({ key: t.key, title: t.title, description: t.description, dependsOn })
  }
  return { tickets: clean }
}

// --- approveFeatureRequestPlan: file the Linear project and tickets (DAN-51) ---

// The agent harness each session model maps to, for the `agent:<harness>`
// label on every filed issue. The ONE place this mapping lives; an unknown
// model falls back to the claude harness. The non-claude roster models map to
// the claude harness FOR NOW — it is the only harness that exists; per-model
// harness routing arrives with its own ticket (DAN-65 scopes this to the
// mapping only).
export const HARNESS_BY_MODEL = {
  'claude-opus-5': 'claude',
  'gpt-5.6-terra': 'claude',
  'gemini-3.6-flash': 'claude',
  'gpt-oss-120b': 'claude',
}
const DEFAULT_HARNESS = 'claude'

// Project names derive from the session's first user message, truncated so a
// long opening message doesn't become an unreadable project title. Linear
// rejects projectCreate names longer than 80 characters (DAN-88), so the cap
// applies to the WHOLE name — prefix, base, and ellipsis included: the base is
// bounded at PROJECT_NAME_MAX − prefix − 1, leaving room for the '…'.
const PROJECT_NAME_PREFIX = 'paf: '
const PROJECT_NAME_MAX = 80

export function projectName(doc) {
  const first = doc.messages.find((m) => m.role === 'user')?.content ?? doc._id.toString()
  const max = PROJECT_NAME_MAX - PROJECT_NAME_PREFIX.length
  let base = first
  if (first.length > max) {
    let cut = first.slice(0, max - 1)
    // Never end the cut on a high surrogate — that would split an emoji or
    // other astral character and leave a broken pair before the ellipsis.
    const last = cut.charCodeAt(cut.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
    base = `${cut}…`
  }
  return `${PROJECT_NAME_PREFIX}${base}`
}

// DAN-90's structural guarantee against DAN-88's cap, checked once at module
// load rather than asserted per approval: a title is bounded at
// TITLE_MAX_CHARS, so `paf: ` + any title is bounded at 55 — comfortably
// inside Linear's 80. If someone later raises TITLE_MAX_CHARS past the point
// where that holds, the process refuses to start instead of filing project
// names Linear rejects at approval time.
if (PROJECT_NAME_PREFIX.length + TITLE_MAX_CHARS > PROJECT_NAME_MAX) {
  throw new Error(
    `title budget ${TITLE_MAX_CHARS} + prefix ${PROJECT_NAME_PREFIX.length} exceeds the ${PROJECT_NAME_MAX}-char Linear project-name cap`,
  )
}

// A leading label the model may prepend despite being told not to
// ("Title: foo", "slug - foo", "**Name:** foo"). Stripped narrowly: only at
// the very start, only these words, only when a separator follows.
const TITLE_LABEL_PREAMBLE = /^[\s"'`*_#>[(-]*(?:the\s+)?(?:title|slug|name|answer|output)\s*[:\-–—]+\s*/i

// Anything that separates words: whitespace, ASCII hyphen, and the unicode
// dash family (an em-dash between words must not glue them together once the
// strip step below removes it).
const TITLE_SEPARATORS = /[\s\u2010-\u2015-]+/g

// Turn whatever the titler actually emitted into a slug matching
// TITLE_PATTERN, or null when nothing usable survives. MANDATORY on every
// model reply — the prompt asks for a bare slug, but the model's formatting is
// never trusted, exactly as the internal JSON roles never trust theirs
// (extractJsonObject). Null is not an error: the caller falls back to
// projectName() and the approval proceeds.
//
// Steps, in order: unwrap a markdown fence; drop a "Title:"-style label; keep
// only the first non-empty line (a model that adds an explanation puts it on a
// later line, and the slug is the part we want); lowercase; separators → '_';
// strip everything outside [a-z0-9_]; collapse repeated '_'; trim leading and
// trailing '_'; cap at TITLE_MAX_WORDS words and TITLE_MAX_CHARS characters,
// dropping WHOLE trailing words so the result never ends mid-word.
export function sanitizeTitle(raw) {
  if (typeof raw !== 'string') return null

  let text = raw
  const fence = text.match(/```[a-z]*\s*\r?\n?([\s\S]*?)```/i)
  if (fence) text = fence[1]
  text = text.trim().replace(TITLE_LABEL_PREAMBLE, '')
  text = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '') ?? ''

  text = text
    .toLowerCase()
    .replace(TITLE_SEPARATORS, '_')
    .replace(/[^a-z0-9_]+/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')

  const words = text.split('_').filter((word) => word !== '').slice(0, TITLE_MAX_WORDS)
  while (words.length > 1 && words.join('_').length > TITLE_MAX_CHARS) {
    words.pop()
  }
  // A single word longer than the cap has no whole-word boundary to fall back
  // to, so it is cut — the only place a title can end mid-word.
  const slug = words.join('_').slice(0, TITLE_MAX_CHARS).replace(/_+$/, '')

  return TITLE_PATTERN.test(slug) ? slug : null
}

// Ask the titler for this session's slug, or return null when it cannot be
// had. EVERY failure mode collapses to null: a gateway error, a quota refusal
// (QuotaExhaustedError — deliberately NOT re-thrown here, unlike in the
// conversational turns), a missing/oddly-shaped completion, or model output
// that sanitizes to nothing. A title is a nicety; the approval the user just
// asked for is not, so nothing this function does can fail an approval or
// surface an error to the client.
//
// The call goes through the SAME injected gateway client as every other role,
// carrying this session's promptId — so the titler's tokens land on the usual
// ledger under the usual attribution and featureRequestCost sees them. There
// is no side channel.
async function generateTitle(uid, id, doc, aiGateway) {
  if (typeof aiGateway?.chat !== 'function') return null
  try {
    const completion = await aiGateway.chat({
      uid,
      promptId: id,
      role: TITLER_ROLE,
      model: TITLE_MODEL,
      max_tokens: MAX_TOKENS_BY_ROLE[TITLER_ROLE],
      messages: [
        { role: 'system', content: TITLE_PROMPT },
        { role: 'user', content: transcriptAsText(doc.messages ?? []) },
      ],
    })
    return sanitizeTitle(completion?.choices?.[0]?.message?.content)
  } catch {
    // Swallowed deliberately — see above. Approval continues on the DAN-88
    // truncated name.
    return null
  }
}

// Approve the caller's session: file one Linear project plus one issue per
// plan ticket (labels, blocked-by relations, Ready for Dev for unblocked
// tickets), then persist status "building", the project id, and the filed
// ticket identities. Returns the updated session.
//
// Ordering is the crash-consistency story: every Linear call happens BEFORE
// the session document is touched, so a Linear failure mid-creation
// propagates (→ INTERNAL) while the session stays "gathering" and a retry
// remains possible. Partial cleanup of whatever Linear work did land is
// explicitly out of scope for DAN-51 — a retry may file a duplicate project,
// and that is the accepted trade-off, stated here rather than hidden.
//
// DAN-90 adds one AI call to this flow: the titler, run just before
// createProject, whose slug becomes the project name and is persisted as
// `title`. It is strictly best-effort — see generateTitle.
export async function approveFeatureRequestPlan(uid, id, linearClient, aiGateway) {
  const _id = toObjectId(id)
  const doc = await collection().findOne({ _id, uid })
  if (!doc) {
    // Same rule as getFeatureRequest: another user's session is
    // indistinguishable from a nonexistent one.
    throw new NotFoundError('feature request not found')
  }
  if (doc.status !== 'gathering') {
    throw new ValidationError('feature request already approved')
  }

  // The three hard gates (DAN-50). A session that has never been evaluated
  // exposes the synthesized all-failed gates, so it is not approvable either.
  const entranceCriteria = doc.entranceCriteria ?? unevaluatedEntranceCriteria()
  if (!allGatesPass(entranceCriteria)) {
    const failing = ENTRANCE_GATES.filter((gate) => entranceCriteria[gate]?.pass !== true)
    throw new ValidationError(
      `feature request is not approvable: failing gate(s): ${failing.join(', ')}`,
    )
  }

  const plan = doc.plan
  if (!hasStoredPlan(plan)) {
    // Gates can pass without a converged plan — there is nothing to file yet.
    // Since DAN-75 such a session already serves approvable:false, so a
    // well-behaved client never reaches this; it stays as the backstop for
    // stale or hand-crafted calls, with the message and BAD_USER_INPUT
    // mapping unchanged.
    throw new ValidationError('feature request has no plan to approve')
  }

  // Everything below talks to Linear through the injected client only. The
  // client's config (team, Ready for Dev state) is env-driven and read
  // lazily; a missing value throws a LinearError → INTERNAL, nothing leaked.
  const { teamId, readyForDevStateId } = linearClient.config()

  const harness = HARNESS_BY_MODEL[doc.model] ?? DEFAULT_HARNESS
  const labelNames = [`agent:${harness}`, `prompt:${id}`]
  const labelIdsByName = await linearClient.findOrCreateLabels(labelNames)
  const labelIds = labelNames.map((name) => labelIdsByName[name])

  // The session's title (DAN-90), generated ONCE here and persisted below, so
  // it is stable for the life of the session and never regenerated on a read.
  // null means the titler was unavailable or emitted nothing usable, and the
  // project falls back to DAN-88's truncated-first-message name — the approval
  // itself is never at risk. Both branches are bounded by PROJECT_NAME_MAX:
  // projectName() enforces it directly, and the title branch by construction
  // (see the module-load check next to projectName).
  const title = await generateTitle(uid, id, doc, aiGateway)
  const name = title === null ? projectName(doc) : `${PROJECT_NAME_PREFIX}${title}`

  const project = await linearClient.createProject({
    name,
    teamId,
    description: `Filed by prompt-a-feature from session ${id}.`,
  })

  // One issue per plan ticket, in plan order. "No blockers → Ready for Dev"
  // is set at CREATE time via stateId; blocked tickets omit stateId and land
  // in the team's default state (Backlog).
  const issuesByKey = new Map()
  for (const ticket of plan.tickets) {
    const issue = await linearClient.createIssue({
      teamId,
      projectId: project.id,
      title: ticket.title,
      description: ticket.description,
      labelIds,
      stateId: ticket.dependsOn.length === 0 ? readyForDevStateId : undefined,
    })
    issuesByKey.set(ticket.key, issue)
  }

  // Blocked-by relations, exactly the plan's dependsOn edges: for each edge
  // "T depends on D", the blocker D `blocks` the dependent T (Linear renders
  // the inverse "blocked by" on T automatically).
  for (const ticket of plan.tickets) {
    for (const dependencyKey of ticket.dependsOn) {
      const blocker = issuesByKey.get(dependencyKey)
      if (!blocker) {
        // A dangling key would file a silently incomplete dependency graph;
        // fail loudly instead (→ INTERNAL, session stays "gathering").
        throw new Error(
          `plan ticket ${ticket.key} depends on unknown key ${dependencyKey}`,
        )
      }
      await linearClient.createRelation({
        issueId: blocker.id,
        relatedIssueId: issuesByKey.get(ticket.key).id,
        type: 'blocks',
      })
    }
  }

  // Only now — every Linear call succeeded — does the session move to
  // "building", carrying the project id and each filed ticket's identity.
  //
  // DAN-90: `title` is written ONLY when a slug was actually produced. A
  // fallback approval leaves the field absent, so a stored `title` always
  // matches TITLE_PATTERN — the wire contract is "null or a slug", never a
  // truncated sentence masquerading as one.
  const update = {
    status: 'building',
    linearProjectId: project.id,
    // DAN-80: the project's Linear URL, captured from projectCreate at
    // approval time so the frontend can link straight to the project.
    // Sessions approved before this field existed simply lack it and
    // serve null — never an error.
    linearProjectUrl: project.url ?? null,
    tickets: plan.tickets.map((ticket) => {
      const issue = issuesByKey.get(ticket.key)
      return {
        key: ticket.key,
        linearIssueId: issue.id,
        identifier: issue.identifier,
        url: issue.url,
      }
    }),
  }
  if (title !== null) update.title = title

  await collection().updateOne({ _id, uid }, { $set: update })

  return toFeatureRequest(await collection().findOne({ _id, uid }))
}

// --- featureRequestProgress: live per-ticket build status (DAN-52) ---

// The five wire states the watch-it-build view renders. Mapping from Linear's
// workflow state (state.type + state.name):
//
//   type "completed"                     -> DONE
//   type "started", name "In Review"     -> IN_REVIEW  (see below)
//   type "started", any other name       -> IN_PROGRESS
//   anything else, PR attachment present -> BOUNCED    (sent back after review)
//   anything else, no PR attachment      -> BACKLOG
//
// "In Review" is special-cased BY NAME: in this team it is a started-type
// state named "In Review", indistinguishable from "In Progress" by type alone.
// The name match is case-insensitive so a rename to "in review" doesn't
// silently demote every reviewing ticket to IN_PROGRESS.
//
// "Anything else" covers Linear's backlog/unstarted/triage types — and any
// type this code doesn't know (e.g. canceled) — so the wire state is always
// one of the five, never a passthrough of Linear's vocabulary. A ticket
// sitting in a backlog-family state WITH a PR attached is one that review
// bounced back to the developer: work exists, but it is queued again.
const IN_REVIEW_STATE_NAME = 'in review'

function toTicketBuildState(state, hasPrAttachment) {
  if (state?.type === 'completed') return 'DONE'
  if (state?.type === 'started') {
    return (state.name ?? '').trim().toLowerCase() === IN_REVIEW_STATE_NAME
      ? 'IN_REVIEW'
      : 'IN_PROGRESS'
  }
  return hasPrAttachment ? 'BOUNCED' : 'BACKLOG'
}

// The issue's PR attachment, or null. Linear's GitHub integration attaches
// the pull request to the issue; the attachment carries the PR's url and a
// sourceType. Either signal identifies it (DAN-52): a url containing
// github.com/…/pull/ OR a sourceType mentioning github. First match wins —
// an issue in this workflow has one PR.
function findPrAttachment(attachments) {
  const nodes = attachments?.nodes ?? []
  return (
    nodes.find(
      (a) =>
        (typeof a?.url === 'string' && /github\.com\/.+\/pull\//.test(a.url)) ||
        (typeof a?.sourceType === 'string' && a.sourceType.toLowerCase().includes('github')),
    ) ?? null
  )
}

// A ~10-second in-memory cache over the Linear read, keyed by promptId — the
// watch-it-build view polls, and every viewer of a session re-reading Linear
// on each poll would hammer their API for data that changes on a human
// timescale. Deliberately simple: a Map of { at, nodes } with timestamps, no
// eviction (one entry per watched session, process lifetime). Only the LINEAR
// fetch is cached — the session read (and with it the uid scoping and
// NOT_FOUND behavior) runs on every call, so the cache can never leak one
// user's view to another. Clearable, and `now` is injectable, for tests.
export const PROGRESS_CACHE_TTL_MS = 10_000
const progressCache = new Map()

export function clearFeatureRequestProgressCache() {
  progressCache.clear()
}

// --- the terminal session status (DAN-94) ------------------------------------

// The third and last session status, after "gathering" (the conversation) and
// "building" (approved, tickets filed, work in flight). A session reaches it
// when every ticket the build view can see is DONE — the work shipped — and it
// is TERMINAL: nothing in this module ever moves a session out of it.
//
// Named "shipped" deliberately, and NOT "completed": `completed` is already
// taken, one abstraction level down, as LINEAR'S workflow-state TYPE inside
// toTicketBuildState above. Two different things called "completed" in one file
// is exactly the confusion this ticket was filed against ("shipped work still
// says building"), so the session-level word is the one the ticket itself uses.
// The exported constant is the ONE place the string lives; nothing hardcodes it.
//
// The flip also stamps `shippedAt` (a Date) alongside the status. It is stored
// only, not on the wire — the ticket asks for a terminal STATUS, and inventing
// a GraphQL field nothing renders would be surface for its own sake. It earns
// its place twice over anyway: it answers "when did this ship" for anyone
// reading the collection, and it is the observable handle that proves the write
// happened exactly once (a re-read that rewrote the status would move it).
export const SHIPPED_STATUS = 'shipped'

// The status a session must be in for the flip to fire. Also the guard that
// makes the write one-way: the update below matches on it, so a shipped session
// can never be re-flipped, and no path here can move one back to building.
//
// Deliberately not a refactor of every 'building' literal in this file —
// approveFeatureRequestPlan's write keeps its own, because this constant exists
// to name the DAN-94 *precondition*, and renaming unrelated lines would put
// churn in a bug-fix diff. The two can never disagree: this is the only place
// that reads the status back, and it reads it from the same collection.
const BUILDING_STATUS = 'building'

// "The build is finished", defined over the progress nodes this very read is
// about to serve — the SAME rule the DAG uses to stop polling (allDone in
// WatchBuild.jsx): at least one node, every node DONE. Deriving it from the
// nodes rather than from the stored ticket list is what keeps the wire and the
// UI from disagreeing; the one visible consequence is that a filed ticket
// deleted by hand in Linear (skipped, never fabricated — see above) does not
// hold the session open, exactly as it does not hold the DAG's "Build complete"
// banner back today.
function buildIsFinished(nodes) {
  return nodes.length > 0 && nodes.every((node) => node.state === 'DONE')
}

// Live per-ticket build status for the caller's session, read from Linear on
// demand through the injected client (DAN-52). One node per filed ticket, in
// the order the tickets were filed:
//   { issueId, identifier, title, state, issueUrl, prUrl, blockedBy }
//
// A session that has not been approved yet has no filed tickets and returns
// [] without touching Linear — progress is approved-only data. An unknown
// promptId (or another user's session, or a malformed id) is the same
// NotFoundError as everywhere else in this module.
//
// A filed ticket Linear no longer returns (deleted by hand in Linear) is
// skipped rather than fabricated — better a missing row than an invented one.
//
// DAN-94 makes this read SELF-HEALING: when the freshly-fetched nodes say the
// build is finished, the session's status is moved to SHIPPED_STATUS once,
// here, before the nodes are returned. The alternative — deriving the terminal
// state on the list query — would cost one Linear round trip per row of "My
// requests", every time it loads; this rides a tick that already happens (the
// build view polls this query, and stops polling on exactly this condition),
// costs nothing when the answer has not changed, and leaves the answer
// PERSISTED so the list query stays a pure Mongo read.
//
// Four properties, all load-bearing:
//  - Own-session only. The write reuses the SAME uid-scoped filter as the read
//    above, so it can only ever touch the caller's own document. It also sits
//    on the cache-MISS path, after a fetch this caller's read actually
//    performed — a warm cache returns early and writes nothing at all, so the
//    DAN-52 rule ("a warm cache never bypasses the uid check") extends to the
//    write for free: there is no cached-path write to bypass anything with.
//  - Exactly once. The filter requires status "building", so the second and
//    every later read match nothing and rewrite nothing — including
//    `shippedAt`, which is therefore the moment the session FIRST shipped, not
//    the moment it was last looked at. The in-memory status check in front of
//    it means a shipped session issues no write at all.
//  - Never backwards. "building" in the filter is also the only status the
//    flip accepts, so nothing here can move a shipped session back; there is
//    no code path in this module that writes "building" over "shipped".
//  - Never fatal. A progress read is a read; if the heal write throws (a Mongo
//    blip), the nodes the caller asked for are still returned and the next
//    poll simply tries again. The status is derived from Linear's truth, so a
//    missed write costs nothing but a delay.
export async function featureRequestProgress(uid, id, linearClient, now = Date.now) {
  const _id = toObjectId(id)
  const doc = await collection().findOne({ _id, uid })
  if (!doc) {
    throw new NotFoundError('feature request not found')
  }

  const tickets = doc.tickets ?? []
  if (tickets.length === 0) return []

  const cached = progressCache.get(id)
  if (cached && now() - cached.at < PROGRESS_CACHE_TTL_MS) {
    return cached.nodes
  }

  const issues = await linearClient.issuesProgress(tickets.map((t) => t.linearIssueId))
  const issuesById = new Map(issues.map((issue) => [issue.id, issue]))

  const nodes = []
  for (const ticket of tickets) {
    const issue = issuesById.get(ticket.linearIssueId)
    if (!issue) continue
    const prAttachment = findPrAttachment(issue.attachments)
    nodes.push({
      issueId: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      state: toTicketBuildState(issue.state, prAttachment !== null),
      issueUrl: issue.url,
      prUrl: prAttachment?.url ?? null,
      // The issues this one is blocked by: inverseRelations are the relations
      // where this issue is the target, so a "blocks" entry's `issue` is the
      // blocker. Non-blocks relation types (relates, duplicates) are ignored.
      blockedBy: (issue.inverseRelations?.nodes ?? [])
        .filter((rel) => rel?.type === 'blocks' && rel.issue?.id)
        .map((rel) => rel.issue.id),
    })
  }

  // The self-healing flip (DAN-94). Guarded twice on purpose: the in-memory
  // check keeps a shipped session from issuing any write at all on a later
  // read, and the status in the update FILTER is what makes the write itself
  // atomic and one-way — two concurrent polls of the same session race into
  // the same single flip, and whichever loses matches nothing.
  if (doc.status === BUILDING_STATUS && buildIsFinished(nodes)) {
    try {
      await collection().updateOne(
        { _id, uid, status: BUILDING_STATUS },
        { $set: { status: SHIPPED_STATUS, shippedAt: new Date() } },
      )
    } catch (err) {
      // Deliberately swallowed: this is a READ the build view polls, and a
      // cosmetic status heal must never take the DAG down with it. Logged
      // server-side rather than silently dropped; the next poll retries, and
      // the truth it derives from lives in Linear, not here.
      console.error(err)
    }
  }

  progressCache.set(id, { at: now(), nodes })
  return nodes
}

// --- featureRequestActivity: the build narrated from the ticket trail (DAN-83) ---

// The agents already narrate the build into Linear — issue comments, workflow
// state changes — and GitHub (the PR attachment). featureRequestActivity
// aggregates that trail per session into one chronological feed of
// ActivityEvents: { ts, ticketIdentifier, kind, summary, body?, url? } with
// kind one of "comment" | "state" | "pr".

// Comment bodies are display data, not archives: the feed truncates them so
// one long tester verdict doesn't dominate the wire payload. The full text
// lives one click away at the event's url.
export const ACTIVITY_COMMENT_BODY_MAX = 500

function truncateCommentBody(body) {
  if (body.length <= ACTIVITY_COMMENT_BODY_MAX) return body
  return `${body.slice(0, ACTIVITY_COMMENT_BODY_MAX - 1)}…`
}

// Best-effort author label for a narrated comment, by simple content
// heuristics (DAN-83). The agents post through shared identities (the CI
// workflow's Linear key, the local MCP session), so the comment's Linear user
// doesn't say which AGENT spoke — but the agents' own vocabulary does: the
// tester talks verdicts and acceptance criteria (CLAUDE.md: it "comments the
// verdict on the issue"), the developer talks branches, implementation, and
// its draft PR. Tester wins ties (its verdicts often quote the developer's
// work); anything neither pattern claims is the generic "agent". A display
// label only — nothing authorizes off it.
function commentAuthorLabel(body) {
  const text = body.toLowerCase()
  if (/\btester\b|\bverdict\b|acceptance criteri|\btested\b/.test(text)) return 'tester'
  if (/\bdeveloper\b|draft pr|pull request|\bimplement|\bbranch\b/.test(text)) return 'developer'
  return 'agent'
}

// The pr event's verb and timestamp, from the attachment's metadata — the
// shape VERIFIED against real Linear data (DAN-83 follow-up): GitHub PR
// attachments carry BOTH `metadata.draft` (boolean — the authoritative draft
// bit) and `metadata.status` (lowercase lifecycle string: "open" / "merged" /
// "closed"; a DRAFT PR's status is NOT "draft" — draft-ness lives only in the
// boolean), with `mergedAt` / `closedAt` ISO timestamps alongside once the PR
// reaches those states. So:
//   draft: true      -> "draft PR opened", ts = attachment createdAt
//   status "merged"  -> "PR merged",       ts = metadata.mergedAt (see below)
//   status "closed"  -> "PR closed",       ts = metadata.closedAt (see below)
//   anything else    -> "PR opened",       ts = attachment createdAt
// Merged/closed events prefer their own mergedAt/closedAt timestamp — the
// finale should sort where it happened in the story, not back at the moment
// the PR was first attached — and fall back to the attachment's createdAt
// when the timestamp is absent. The `status === "draft"` branch survives only
// as a harmless fallback for any older metadata shape. Everything reads
// defensively: unknown or missing metadata is an open PR, never an error.
function prEventParts(attachment) {
  const meta = attachment?.metadata ?? {}
  const status = typeof meta.status === 'string' ? meta.status.trim().toLowerCase() : ''
  const tsOr = (candidate) =>
    typeof candidate === 'string' && candidate !== '' ? candidate : attachment.createdAt
  if (meta.draft === true || status === 'draft') {
    return { verb: 'draft PR opened', ts: attachment.createdAt }
  }
  if (status === 'merged') return { verb: 'PR merged', ts: tsOr(meta.mergedAt) }
  if (status === 'closed') return { verb: 'PR closed', ts: tsOr(meta.closedAt) }
  return { verb: 'PR opened', ts: attachment.createdAt }
}

// Same cache story as featureRequestProgress, one Map over: the narration view
// polls, Linear changes on a human timescale, and only the LINEAR fetch is
// cached — the uid-scoped session read runs on every call, so a warm cache can
// never leak one user's trail to another. Clearable, injectable `now`.
export const ACTIVITY_CACHE_TTL_MS = 10_000
const activityCache = new Map()

export function clearFeatureRequestActivityCache() {
  activityCache.clear()
}

// The session's narrated activity, merged chronologically across all filed
// tickets (DAN-83), read from Linear on demand through the injected client in
// ONE query per (cache-missing) refresh. Per ticket:
//   - one "comment" event per issue comment, body truncated to
//     ACTIVITY_COMMENT_BODY_MAX, summary carrying the heuristic author label;
//   - one "state" event per workflow-state transition in the issue history,
//     summary "DAN-101: Backlog → In Progress". History rows that are not
//     state transitions (assignments, label edits — no from/to state) are
//     skipped, as is the creation row (a to-state with no from-state): the
//     feed narrates changes, and filing is already the feed's implicit start;
//   - one "pr" event for the issue's PR attachment (same detection as
//     featureRequestProgress), summary naming its lifecycle state — draft /
//     opened / merged / closed, see prEventParts — timestamped by the
//     attachment's createdAt (the moment the PR reached Linear) except for
//     merged/closed PRs, which prefer their own mergedAt/closedAt.
//
// An unapproved session has no filed tickets and returns [] without touching
// Linear; a foreign, unknown, or malformed promptId is the same NotFoundError
// as everywhere else in this module. A filed ticket Linear no longer returns
// is skipped, not fabricated. Events sort ascending by timestamp; the build
// order (ticket order, then comments/states/pr per ticket) breaks exact ties
// deterministically because Array.prototype.sort is stable.
export async function featureRequestActivity(uid, id, linearClient, now = Date.now) {
  const _id = toObjectId(id)
  const doc = await collection().findOne({ _id, uid })
  if (!doc) {
    throw new NotFoundError('feature request not found')
  }

  const tickets = doc.tickets ?? []
  if (tickets.length === 0) return []

  const cached = activityCache.get(id)
  if (cached && now() - cached.at < ACTIVITY_CACHE_TTL_MS) {
    return cached.events
  }

  const issues = await linearClient.issuesActivity(tickets.map((t) => t.linearIssueId))
  const issuesById = new Map(issues.map((issue) => [issue.id, issue]))

  const events = []
  for (const ticket of tickets) {
    const issue = issuesById.get(ticket.linearIssueId)
    if (!issue) continue
    const identifier = issue.identifier

    for (const comment of issue.comments?.nodes ?? []) {
      if (typeof comment?.body !== 'string' || !comment.createdAt) continue
      events.push({
        ts: comment.createdAt,
        ticketIdentifier: identifier,
        kind: 'comment',
        summary: `${commentAuthorLabel(comment.body)} commented on ${identifier}`,
        body: truncateCommentBody(comment.body),
        url: comment.url ?? issue.url ?? null,
      })
    }

    for (const row of issue.history?.nodes ?? []) {
      const from = row?.fromState?.name
      const to = row?.toState?.name
      if (!from || !to || !row.createdAt) continue
      events.push({
        ts: row.createdAt,
        ticketIdentifier: identifier,
        kind: 'state',
        summary: `${identifier}: ${from} → ${to}`,
        body: null,
        url: issue.url ?? null,
      })
    }

    const prAttachment = findPrAttachment(issue.attachments)
    if (prAttachment?.createdAt) {
      const { verb, ts } = prEventParts(prAttachment)
      events.push({
        ts,
        ticketIdentifier: identifier,
        kind: 'pr',
        summary: `${verb} for ${identifier}`,
        body: null,
        url: prAttachment.url ?? null,
      })
    }
  }

  events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))

  activityCache.set(id, { at: now(), events })
  return events
}

// --- featureRequestCost: per-session AI spend, read from the gateway (DAN-80) ---

// One usage row as the wire expects it: non-null numbers, zeros when the
// gateway has no row (a session whose calls predate the gateway's ledger, or
// one that has never called the gateway, has spent nothing it can report —
// that is a zero, not an error). The gateway's row fields are already
// camelCase and costUsd is already rounded server-side (round6), so this only
// defaults, never renames or re-rounds.
function toFeatureCost(row) {
  return {
    calls: row?.calls ?? 0,
    tokensIn: row?.tokensIn ?? 0,
    tokensOut: row?.tokensOut ?? 0,
    costUsd: row?.costUsd ?? 0,
  }
}

// What this session has cost, read live from the AI gateway's usage ledger
// through the injected client. GET /v1/usage?group_by=prompt_id returns
// (per ai-gateway/src/usage.js):
//   { persona, window, group_by: "prompt_id",
//     rows: [{ group: <promptId-or-null>, calls, tokensIn, tokensOut, costUsd }],
//     total: { calls, tokensIn, tokensOut, costUsd } }
// — one row per prompt, keyed by `group` — and this filters to the caller's
// session. The session read runs FIRST and is uid-scoped, so a foreign or
// unknown promptId is the same NotFoundError as everywhere else in this
// module and never touches the gateway. A gateway failure propagates
// (GatewayError → INTERNAL, logged server-side, nothing leaked); an absent
// row is zeros, not an error.
export async function featureRequestCost(uid, id, aiGateway) {
  const _id = toObjectId(id)
  const doc = await collection().findOne({ _id, uid })
  if (!doc) {
    throw new NotFoundError('feature request not found')
  }

  const body = await aiGateway.usage({ groupBy: 'prompt_id' })
  const rows = Array.isArray(body?.rows) ? body.rows : []
  return toFeatureCost(rows.find((row) => row?.group === id))
}

// Post a user message to the caller's session and run one orchestration round:
// the product owner replies, then the architect, each through the injected AI
// gateway client with the checked-in role prompt as system message; finally the
// internal planner is asked for a strict-JSON plan draft, which is stored on
// the session when it returns one. Returns the updated session.
//
// Persistence is incremental — each message is $pushed as soon as it exists —
// so a gateway failure mid-round (e.g. a 429 on the architect turn) propagates
// to the caller while the user message and every completed turn remain
// persisted: a re-read shows a consistent transcript. Usage recording lives
// inside aiGateway.chat() (DAN-48); nothing here records usage a second time.
export async function sendFeatureRequestMessage(uid, id, content, aiGateway) {
  if (typeof content !== 'string' || content.trim() === '') {
    throw new ValidationError('content must be a non-empty string', 'content')
  }

  const _id = toObjectId(id)
  const doc = await collection().findOne({ _id, uid })
  if (!doc) {
    // Same rule as getFeatureRequest: another user's session is
    // indistinguishable from a nonexistent one.
    throw new NotFoundError('feature request not found')
  }
  if (doc.status === 'approved') {
    throw new ValidationError('an approved feature request no longer accepts messages')
  }

  const transcript = [...doc.messages]
  const append = async (message) => {
    await collection().updateOne({ _id, uid }, { $push: { messages: message } })
    transcript.push(message)
  }

  await append({ role: 'user', content, createdAt: new Date() })

  // One turn each, in order: the product owner refines, the architect assesses
  // the refined proposal (its call sees the PO's fresh turn in the transcript).
  //
  // A turn persists ONLY a non-empty reply (DAN-68). chat() throws on every
  // transport/HTTP failure before this code runs, so the one way an empty
  // assistant message ever reached the database was a 2xx response whose
  // content was absent or empty — the old `?? ''` coalescing persisted it, and
  // replaying it wedged the session (the gateway 400s empty content). Such a
  // response is now a GatewayError: nothing persists for the turn, the round
  // surfaces as INTERNAL (a 429 still throws QuotaExhaustedError inside
  // chat(), keeping its QUOTA_EXHAUSTED mapping), and the transcript stays
  // intact at the last good message.
  for (const role of CONVERSATION_ROLES) {
    const completion = await aiGateway.chat({
      uid,
      promptId: id,
      role,
      model: doc.model,
      // Explicit output budget (DAN-69) — the gateway's provider default
      // (anthropic: 1024) truncated architect replies mid-sentence.
      max_tokens: MAX_TOKENS_BY_ROLE[role],
      messages: [
        { role: 'system', content: await loadRolePrompt(role) },
        ...toChatMessages(transcript, role),
      ],
    })
    const reply = completion.choices?.[0]?.message?.content
    if (typeof reply !== 'string' || reply.trim() === '') {
      // Message is for the server-side log only — INTERNAL never leaks it.
      throw new GatewayError(`AI gateway returned an empty ${role} completion`)
    }
    await append({ role, content: reply, createdAt: new Date() })
  }

  // Plan extraction: one internal call over the full transcript. The whole
  // conversation is a single user message (the planner is an analyst of the
  // exchange, not a participant in it), and response_format asks an
  // OpenAI-compatible gateway to enforce JSON output.
  const planCompletion = await aiGateway.chat({
    uid,
    promptId: id,
    role: PLANNER_ROLE,
    // Dedicated cheap model (DAN-72), not the session's conversation model —
    // see PLANNER_MODEL. Keeps the round inside Hosting's 60s timeout even
    // with the larger planner budget.
    model: PLANNER_MODEL,
    max_tokens: MAX_TOKENS_BY_ROLE[PLANNER_ROLE],
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: PLANNER_PROMPT },
      { role: 'user', content: transcriptAsText(transcript) },
    ],
  })
  const plan = parsePlan(planCompletion.choices?.[0]?.message?.content)
  if (plan) {
    // Latest plan wins — each converged round replaces the draft wholesale.
    await collection().updateOne({ _id, uid }, { $set: { plan } })
  }

  // Entrance-criteria evaluation (DAN-50): one cheap-model structured-JSON
  // call over the same flattened transcript, its usage recorded by the gateway
  // client like every call. Unlike the conversational turns, an evaluator
  // failure must never fail the exchange the user just paid for — a gateway
  // error here (a 429 included) is handled exactly like unparseable output:
  // all three gates fail with "evaluation unavailable", and the next exchange
  // re-evaluates. Latest evaluation wins, replaced wholesale each round.
  let entranceCriteria = null
  try {
    const evaluation = await aiGateway.chat({
      uid,
      promptId: id,
      role: EVALUATOR_ROLE,
      model: ENTRANCE_CRITERIA_MODEL,
      max_tokens: MAX_TOKENS_BY_ROLE[EVALUATOR_ROLE],
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: ENTRANCE_CRITERIA_PROMPT },
        { role: 'user', content: transcriptAsText(transcript) },
      ],
    })
    entranceCriteria = parseEntranceCriteria(evaluation.choices?.[0]?.message?.content)
  } catch {
    // Swallowed deliberately — see the comment above. The chat exchange
    // succeeded; only the evaluation is unavailable this round.
  }
  await collection().updateOne(
    { _id, uid },
    { $set: { entranceCriteria: entranceCriteria ?? failedEntranceCriteria('evaluation unavailable') } },
  )

  return toFeatureRequest(await collection().findOne({ _id, uid }))
}
