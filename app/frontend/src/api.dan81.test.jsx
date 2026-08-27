import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { featureRequestCost, startFeatureRequest } from './api.js'
import { getIdToken } from './auth.js'

// DAN-81: the planning-cost surface of api.js, plus the linearProjectUrl
// addition to the FeatureRequest selection set. Same idiom as api.dan55.test.jsx
// — fetch is stubbed, the call is asserted to be one POST to /api/graphql with
// the right variables, and the query document is matched by operation name and
// field presence only (its formatting is a local choice, not contract).
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

describe('api.featureRequestCost', () => {
  it('POSTs one featureRequestCost query with the promptId variable and resolves the DAN-80 ledger shape', async () => {
    const ledger = { calls: 7, tokensIn: 5120, tokensOut: 2048, costUsd: 0.1234 }
    const fetchMock = gqlOk({ featureRequestCost: ledger })
    vi.stubGlobal('fetch', fetchMock)

    await expect(featureRequestCost('fr1')).resolves.toEqual(ledger)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/graphql')
    expect(options.method).toBe('POST')
    const body = JSON.parse(options.body)
    expect(body.query).toMatch(/featureRequestCost/)
    expect(body.variables).toEqual({ promptId: 'fr1' })
    // The DAN-80 ledger shape is part of the selection set, so the building
    // view needs no second query when the backend lands.
    for (const field of ['calls', 'tokensIn', 'tokensOut', 'costUsd']) {
      expect(body.query).toContain(field)
    }
  })

  it('resolves a zero-cost ledger as-is — zero is a value, not an absence', async () => {
    const zero = { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 }
    vi.stubGlobal('fetch', gqlOk({ featureRequestCost: zero }))
    await expect(featureRequestCost('fr1')).resolves.toEqual(zero)
  })

  it('resolves null when the server has no ledger for the request', async () => {
    vi.stubGlobal('fetch', gqlOk({ featureRequestCost: null }))
    await expect(featureRequestCost('fr1')).resolves.toBeNull()
  })

  it('rejects with the execution-level error message so the stat can degrade silently', async () => {
    vi.stubGlobal(
      'fetch',
      gqlError('feature request not found', { code: 'NOT_FOUND' }),
    )
    await expect(featureRequestCost('missing')).rejects.toMatchObject({
      message: 'feature request not found',
      extensions: { code: 'NOT_FOUND' },
    })
  })
})

describe('DAN-81 FeatureRequest selection set', () => {
  it('requests linearProjectUrl on every FeatureRequest operation (schema-forward on DAN-80)', async () => {
    const fetchMock = gqlOk({
      startFeatureRequest: {
        id: 'fr1',
        status: 'open',
        model: 'claude-opus-5',
        createdAt: '2026-08-27T00:00:00.000Z',
        approvable: false,
        linearProjectUrl: null,
        messages: [],
        entranceCriteria: null,
      },
    })
    vi.stubGlobal('fetch', fetchMock)

    await startFeatureRequest('claude-opus-5')

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.query).toContain('linearProjectUrl')
  })
})
