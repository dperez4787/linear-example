import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { featureRequestActivity } from './api.js'
import { getIdToken } from './auth.js'

// DAN-84: the live-activity surface of api.js. Same idiom as api.dan81.test.jsx
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

const feed = [
  {
    ts: '2026-08-27T10:00:00.000Z',
    ticketIdentifier: 'DAN-101',
    kind: 'state',
    summary: 'DAN-101: Backlog → In Progress',
    body: null,
    url: null,
  },
  {
    ts: '2026-08-27T10:05:00.000Z',
    ticketIdentifier: 'DAN-101',
    kind: 'comment',
    summary: 'tester commented on DAN-101',
    body: 'Looks **good** to me.',
    url: 'https://linear.app/daniel-perez/issue/DAN-101#comment-1',
  },
]

describe('api.featureRequestActivity', () => {
  it('POSTs one featureRequestActivity query with the promptId variable and resolves the DAN-83 event shape', async () => {
    const fetchMock = gqlOk({ featureRequestActivity: feed })
    vi.stubGlobal('fetch', fetchMock)

    await expect(featureRequestActivity('fr1')).resolves.toEqual(feed)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/graphql')
    expect(options.method).toBe('POST')
    const body = JSON.parse(options.body)
    expect(body.query).toMatch(/featureRequestActivity/)
    expect(body.variables).toEqual({ promptId: 'fr1' })
    // The DAN-83 event shape is part of the selection set, so the timeline
    // needs no second query when the backend lands.
    for (const field of ['ts', 'ticketIdentifier', 'kind', 'summary', 'body', 'url']) {
      expect(body.query).toContain(field)
    }
  })

  it('resolves [] for an empty feed — an unapproved session is empty, not an error', async () => {
    vi.stubGlobal('fetch', gqlOk({ featureRequestActivity: [] }))
    await expect(featureRequestActivity('fr1')).resolves.toEqual([])
  })

  it('resolves [] when the server sends no field at all, so callers can always map', async () => {
    vi.stubGlobal('fetch', gqlOk({}))
    await expect(featureRequestActivity('fr1')).resolves.toEqual([])
  })

  it('rejects with the execution-level NOT_FOUND so the feed can degrade silently', async () => {
    vi.stubGlobal(
      'fetch',
      gqlError('feature request not found', { code: 'NOT_FOUND' }),
    )
    await expect(featureRequestActivity('missing')).rejects.toMatchObject({
      message: 'feature request not found',
      extensions: { code: 'NOT_FOUND' },
    })
  })
})
