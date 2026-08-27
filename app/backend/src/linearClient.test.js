// linearClient (DAN-51): unit tests for the default Linear client — request
// shape, lazy env reads, and error typing — with an injected fetch, so no test
// reaches real Linear. Run with: npm test
//
// This file runs in its own process (node --test), so it owns process.env for
// its duration: LINEAR_* vars are set/unset per test, and /health boot is
// asserted with none of them present.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'

import { createLinearClient, LinearError } from './linearClient.js'
import { createApp } from './index.js'

const TEAM_ID = 'team-fixture-id'
const READY_STATE_ID = 'state-ready-fixture-id'

// A capturing fetch scripted with one GraphQL data payload per call, in order.
function scriptedFetch(...dataPayloads) {
  const calls = []
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    const data = dataPayloads.shift()
    return { ok: true, status: 200, json: async () => ({ data }) }
  }
  fn.calls = calls
  return fn
}

beforeEach(() => {
  delete process.env.LINEAR_API_KEY
  delete process.env.LINEAR_TEAM_ID
  delete process.env.LINEAR_STATE_READY_FOR_DEV
})

// --- criterion 1: lazy env, /health boots without any Linear config ---

test('createApp() with the default Linear client boots and serves /health with no LINEAR_* env set', async () => {
  const app = createApp()
  const res = await request(app).get('/health')
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { status: 'ok' })
})

test('a call without LINEAR_API_KEY throws a LinearError and never touches the transport', async () => {
  const fetchImpl = scriptedFetch()
  const client = createLinearClient({ fetch: fetchImpl })
  await assert.rejects(
    () => client.createProject({ name: 'x', teamId: TEAM_ID, description: 'y' }),
    (err) => err instanceof LinearError && /LINEAR_API_KEY/.test(err.message),
  )
  assert.equal(fetchImpl.calls.length, 0, 'no request without configuration')
})

test('config() without LINEAR_TEAM_ID / LINEAR_STATE_READY_FOR_DEV throws a LinearError; with them set it returns both', () => {
  const client = createLinearClient({ fetch: scriptedFetch() })
  assert.throws(() => client.config(), LinearError)

  process.env.LINEAR_TEAM_ID = TEAM_ID
  assert.throws(() => client.config(), LinearError, 'both values are required')

  process.env.LINEAR_STATE_READY_FOR_DEV = READY_STATE_ID
  assert.deepEqual(client.config(), { teamId: TEAM_ID, readyForDevStateId: READY_STATE_ID })
})

// --- request shape: endpoint, bare Authorization header, timeout ---

test('createProject posts to the Linear GraphQL endpoint with a bare Authorization header (no Bearer prefix) and a timeout signal', async () => {
  process.env.LINEAR_API_KEY = 'lin_api_fixture'
  const fetchImpl = scriptedFetch({
    projectCreate: { project: { id: 'proj-1', url: 'https://linear.app/x/project/1' } },
  })
  const client = createLinearClient({ fetch: fetchImpl })

  const project = await client.createProject({
    name: 'paf: fixture',
    teamId: TEAM_ID,
    description: 'desc',
  })

  assert.deepEqual(project, { id: 'proj-1', url: 'https://linear.app/x/project/1' })
  assert.equal(fetchImpl.calls.length, 1)
  const { url, init, body } = fetchImpl.calls[0]
  assert.equal(url, 'https://api.linear.app/graphql')
  assert.equal(init.method, 'POST')
  assert.equal(
    init.headers.Authorization,
    'lin_api_fixture',
    'personal API keys are sent bare — a Bearer prefix would be rejected',
  )
  assert.ok(init.signal instanceof AbortSignal, 'the request carries a timeout signal')
  assert.deepEqual(body.variables, {
    input: { name: 'paf: fixture', teamIds: [TEAM_ID], description: 'desc' },
  })
})

test('createIssue omits stateId from the input when none is given, and includes it when given', async () => {
  process.env.LINEAR_API_KEY = 'lin_api_fixture'
  const issue = { issueCreate: { issue: { id: 'i-1', identifier: 'DAN-1', url: 'u' } } }
  const fetchImpl = scriptedFetch(issue, issue)
  const client = createLinearClient({ fetch: fetchImpl })

  await client.createIssue({
    teamId: TEAM_ID,
    projectId: 'proj-1',
    title: 't',
    description: 'd',
    labelIds: ['l1'],
  })
  assert.ok(
    !('stateId' in fetchImpl.calls[0].body.variables.input),
    'no stateId key at all — the team default state (Backlog) applies',
  )

  await client.createIssue({
    teamId: TEAM_ID,
    projectId: 'proj-1',
    title: 't',
    description: 'd',
    labelIds: ['l1'],
    stateId: READY_STATE_ID,
  })
  assert.equal(fetchImpl.calls[1].body.variables.input.stateId, READY_STATE_ID)
})

test('findOrCreateLabels reuses existing labels and creates only the missing ones', async () => {
  process.env.LINEAR_API_KEY = 'lin_api_fixture'
  process.env.LINEAR_TEAM_ID = TEAM_ID
  process.env.LINEAR_STATE_READY_FOR_DEV = READY_STATE_ID
  const fetchImpl = scriptedFetch(
    { issueLabels: { nodes: [{ id: 'label-existing', name: 'agent:claude' }] } },
    { issueLabelCreate: { issueLabel: { id: 'label-created', name: 'prompt:abc' } } },
  )
  const client = createLinearClient({ fetch: fetchImpl })

  const ids = await client.findOrCreateLabels(['agent:claude', 'prompt:abc'])

  assert.deepEqual(ids, { 'agent:claude': 'label-existing', 'prompt:abc': 'label-created' })
  assert.equal(fetchImpl.calls.length, 2, 'one lookup, one create for the one missing label')
  assert.deepEqual(fetchImpl.calls[1].body.variables.input, {
    teamId: TEAM_ID,
    name: 'prompt:abc',
  })
})

// --- error typing: every failure mode is a LinearError, message server-side only ---

test('a non-2xx response, a GraphQL-level error, and a network failure all throw LinearError', async () => {
  process.env.LINEAR_API_KEY = 'lin_api_fixture'

  const non2xx = createLinearClient({
    fetch: async () => ({ ok: false, status: 400, json: async () => ({}) }),
  })
  await assert.rejects(
    () => non2xx.createRelation({ issueId: 'a', relatedIssueId: 'b', type: 'blocks' }),
    (err) => err instanceof LinearError && /400/.test(err.message),
  )

  const gqlErrors = createLinearClient({
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ errors: [{ message: 'entity not found' }] }),
    }),
  })
  await assert.rejects(
    () => gqlErrors.createRelation({ issueId: 'a', relatedIssueId: 'b', type: 'blocks' }),
    LinearError,
  )

  const network = createLinearClient({
    fetch: async () => {
      throw new Error('socket hang up')
    },
  })
  await assert.rejects(
    () => network.createRelation({ issueId: 'a', relatedIssueId: 'b', type: 'blocks' }),
    (err) => err instanceof LinearError && /socket hang up/.test(err.message),
  )
})
