import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  approveFeatureRequestPlan,
  myAiUsage,
  startFeatureRequest,
} from './api.js'
import { getIdToken } from './auth.js'

// DAN-54: the AI-usage and approval surface of api.js, plus the extensions
// carry-through on thrown execution-level errors. Same idiom as
// api.dan53.test.jsx — fetch is stubbed, each call is asserted to be one POST
// to /api/graphql with the right variables, and the query document is matched
// by operation name only (its formatting is a local choice, not contract).
vi.mock('./auth.js', () => ({
  getIdToken: vi.fn(async () => null),
  signOutUser: vi.fn(async () => {}),
}))

beforeEach(() => {
  vi.mocked(getIdToken).mockResolvedValue(null)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// A successful GraphQL response: HTTP 200 with { data }.
function gqlOk(data) {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data }) }))
}

// An execution-level GraphQL error: HTTP 200 with a non-empty errors array.
function gqlError(message, extensions) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: null, errors: [{ message, extensions }] }),
  }))
}

// Parse the single fetch call into { url, method, body } for assertions.
function calledWith(fetchMock) {
  const [url, options] = fetchMock.mock.calls[0]
  return { url, method: options.method, body: JSON.parse(options.body) }
}

describe('api.myAiUsage', () => {
  it('POSTs one myAiUsage query and resolves { requests, totalTokens }', async () => {
    const usage = { requests: 7, totalTokens: 4321 }
    const fetchMock = gqlOk({ myAiUsage: usage })
    vi.stubGlobal('fetch', fetchMock)

    await expect(myAiUsage()).resolves.toEqual(usage)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const call = calledWith(fetchMock)
    expect(call.url).toBe('/api/graphql')
    expect(call.method).toBe('POST')
    expect(call.body.query).toMatch(/myAiUsage/)
  })
})

describe('api.approveFeatureRequestPlan', () => {
  it('POSTs one approveFeatureRequestPlan mutation with the id variable and resolves the updated request', async () => {
    const updated = {
      id: 'fr1',
      status: 'building',
      model: 'claude-opus-5',
      createdAt: '2026-08-26T00:00:00.000Z',
      approvable: false,
      messages: [],
      entranceCriteria: null,
    }
    const fetchMock = gqlOk({ approveFeatureRequestPlan: updated })
    vi.stubGlobal('fetch', fetchMock)

    await expect(approveFeatureRequestPlan('fr1')).resolves.toEqual(updated)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const call = calledWith(fetchMock)
    expect(call.url).toBe('/api/graphql')
    expect(call.method).toBe('POST')
    expect(call.body.query).toMatch(/approveFeatureRequestPlan/)
    expect(call.body.variables).toEqual({ id: 'fr1' })
    // The agreed DAN-50/51 shape is part of the selection set, so the checklist
    // and the Approve gate need no second query when the backend lands.
    expect(call.body.query).toMatch(/entranceCriteria/)
    expect(call.body.query).toMatch(/approvable/)
  })
})

describe('execution-level errors carry extensions (quota exhaustion)', () => {
  it('rejects with an Error whose extensions.code is QUOTA_EXHAUSTED when the backend says so', async () => {
    vi.stubGlobal(
      'fetch',
      gqlError('AI request quota exhausted', { code: 'QUOTA_EXHAUSTED' }),
    )

    await expect(startFeatureRequest('claude-opus-5')).rejects.toMatchObject({
      message: 'AI request quota exhausted',
      extensions: { code: 'QUOTA_EXHAUSTED' },
    })
  })

  it('still attaches err.field alongside extensions on BAD_USER_INPUT', async () => {
    vi.stubGlobal(
      'fetch',
      gqlError('model is required', { code: 'BAD_USER_INPUT', field: 'model' }),
    )

    await expect(startFeatureRequest('')).rejects.toMatchObject({
      message: 'model is required',
      field: 'model',
      extensions: { code: 'BAD_USER_INPUT', field: 'model' },
    })
  })
})
