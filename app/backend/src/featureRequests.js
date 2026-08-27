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

import { getDb } from './db.js'
import { NotFoundError } from './records.js'
import { loadRolePrompt, CONVERSATION_ROLES } from './roles.js'
import { ValidationError } from './schema.js'

const COLLECTION = 'feature_requests'

// The models a session may be opened against. Validation lives here (not in
// schema.js, which is the Record validation module) but throws the same
// ValidationError class, so the one GraphQL error mapper turns it into the
// same BAD_USER_INPUT + field shape as every record validation failure.
export const FEATURE_REQUEST_MODELS = ['claude-opus-5']

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
  let parsed
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
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

// Map the persisted transcript into the chat shape one role's gateway call
// expects. The calling role sees its own prior turns as `assistant`; the user's
// turns are `user`; the OTHER agent's turns are also `user`, prefixed with
// their name so attribution survives the two-party chat format.
function toChatMessages(transcript, selfRole) {
  return transcript.map(({ role, content }) => {
    if (role === selfRole) return { role: 'assistant', content }
    if (role === 'user') return { role: 'user', content }
    return { role: 'user', content: `[${role}] ${content}` }
  })
}

// Flatten the transcript for an internal analyst role (planner, evaluator):
// the whole conversation is a single user message, because those roles analyze
// the exchange rather than participate in it.
function transcriptAsText(transcript) {
  return transcript.map(({ role, content }) => `${role}: ${content}`).join('\n\n')
}

// Parse and validate the planner's reply into a plan, or null when there is no
// (usable) plan. A malformed or empty reply means "not converged yet" — the
// conversation continues and nothing is stored; it is never a client error.
function parsePlan(content) {
  let parsed
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
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
  for (const role of CONVERSATION_ROLES) {
    const completion = await aiGateway.chat({
      uid,
      promptId: id,
      role,
      model: doc.model,
      messages: [
        { role: 'system', content: await loadRolePrompt(role) },
        ...toChatMessages(transcript, role),
      ],
    })
    await append({
      role,
      content: completion.choices?.[0]?.message?.content ?? '',
      createdAt: new Date(),
    })
  }

  // Plan extraction: one internal call over the full transcript. The whole
  // conversation is a single user message (the planner is an analyst of the
  // exchange, not a participant in it), and response_format asks an
  // OpenAI-compatible gateway to enforce JSON output.
  const planCompletion = await aiGateway.chat({
    uid,
    promptId: id,
    role: PLANNER_ROLE,
    model: doc.model,
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
