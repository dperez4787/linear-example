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

// A session is approvable iff every gate passes. Derived, never stored —
// a derived value cannot drift from the gates it summarizes.
export function isApprovable(entranceCriteria) {
  return ENTRANCE_GATES.every((gate) => entranceCriteria[gate]?.pass === true)
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
// long opening message doesn't become an unreadable project title.
const PROJECT_NAME_PREFIX = 'paf: '
const PROJECT_NAME_MAX = 80

function projectName(doc) {
  const first = doc.messages.find((m) => m.role === 'user')?.content ?? doc._id.toString()
  const base = first.length > PROJECT_NAME_MAX ? `${first.slice(0, PROJECT_NAME_MAX - 1)}…` : first
  return `${PROJECT_NAME_PREFIX}${base}`
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
export async function approveFeatureRequestPlan(uid, id, linearClient) {
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
  if (!isApprovable(entranceCriteria)) {
    const failing = ENTRANCE_GATES.filter((gate) => entranceCriteria[gate]?.pass !== true)
    throw new ValidationError(
      `feature request is not approvable: failing gate(s): ${failing.join(', ')}`,
    )
  }

  const plan = doc.plan
  if (!plan?.tickets?.length) {
    // Gates can pass without a converged plan — there is nothing to file yet.
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

  const project = await linearClient.createProject({
    name: projectName(doc),
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
  await collection().updateOne(
    { _id, uid },
    {
      $set: {
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
      },
    },
  )

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

  progressCache.set(id, { at: now(), nodes })
  return nodes
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
