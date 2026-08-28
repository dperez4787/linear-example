import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ticketCosts } from './api.js'
import { getIdToken } from './auth.js'

// DAN-103: the per-ticket build-cost surface of api.js — ticketCosts(promptId),
// schema-forward on DAN-101 exactly as featureRequestCost was on DAN-80. Same
// idiom as api.dan81.test.jsx — fetch is stubbed, the call is asserted to be
// one POST to /api/graphql with the right variables, and the query document is
// matched by operation name and field presence only (its formatting is a local
// choice, not contract).
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

const rows = [
  {
    ticketIdentifier: 'DAN-90',
    leg: 'develop',
    model: 'claude-opus-5',
    costUsd: 0.21,
    recordedAt: '2026-08-27T10:00:00.000Z',
  },
  {
    ticketIdentifier: 'DAN-90',
    leg: 'test',
    model: 'gpt-5.6-terra',
    costUsd: 0.09,
    recordedAt: '2026-08-27T10:05:00.000Z',
  },
]

describe('api.ticketCosts', () => {
  it('POSTs one ticketCosts query with the promptId variable and resolves the DAN-101 row shape', async () => {
    const fetchMock = gqlOk({ ticketCosts: rows })
    vi.stubGlobal('fetch', fetchMock)

    await expect(ticketCosts('fr1')).resolves.toEqual(rows)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/graphql')
    expect(options.method).toBe('POST')
    const body = JSON.parse(options.body)
    expect(body.query).toMatch(/ticketCosts/)
    expect(body.variables).toEqual({ promptId: 'fr1' })
    // The DAN-101 row shape is part of the selection set, so the cost
    // breakdown needs no second query when the backend lands.
    for (const field of [
      'ticketIdentifier',
      'leg',
      'model',
      'costUsd',
      'recordedAt',
    ]) {
      expect(body.query).toContain(field)
    }
  })

  it('resolves [] when the server reports no recorded legs — legacy is empty, not an error', async () => {
    vi.stubGlobal('fetch', gqlOk({ ticketCosts: [] }))
    await expect(ticketCosts('fr1')).resolves.toEqual([])
  })

  it('resolves [] for a null payload so callers can always map', async () => {
    vi.stubGlobal('fetch', gqlOk({ ticketCosts: null }))
    await expect(ticketCosts('fr1')).resolves.toEqual([])
  })

  it('rejects with the execution-level error so the breakdown can degrade silently', async () => {
    vi.stubGlobal(
      'fetch',
      gqlError('feature request not found', { code: 'NOT_FOUND' }),
    )
    await expect(ticketCosts('missing')).rejects.toMatchObject({
      message: 'feature request not found',
      extensions: { code: 'NOT_FOUND' },
    })
  })
})
