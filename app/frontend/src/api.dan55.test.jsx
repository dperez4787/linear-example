import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { featureRequestProgress } from './api.js'
import { getIdToken } from './auth.js'

// DAN-55: the build-progress surface of api.js. Same idiom as api.dan54.test.jsx
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

describe('api.featureRequestProgress', () => {
  it('POSTs one featureRequestProgress query with the promptId variable and resolves the TicketProgress array', async () => {
    const progress = [
      {
        issueId: 'iss-1',
        identifier: 'DAN-67',
        title: 'Backend contract',
        state: 'DONE',
        issueUrl: 'https://linear.app/daniel-perez/issue/DAN-67',
        prUrl: 'https://github.com/dperez4787/linear-example/pull/61',
        blockedBy: [],
      },
      {
        issueId: 'iss-2',
        identifier: 'DAN-68',
        title: 'API layer',
        state: 'IN_PROGRESS',
        issueUrl: 'https://linear.app/daniel-perez/issue/DAN-68',
        prUrl: null,
        blockedBy: ['DAN-67'],
      },
    ]
    const fetchMock = gqlOk({ featureRequestProgress: progress })
    vi.stubGlobal('fetch', fetchMock)

    await expect(featureRequestProgress('fr1')).resolves.toEqual(progress)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/graphql')
    expect(options.method).toBe('POST')
    const body = JSON.parse(options.body)
    expect(body.query).toMatch(/featureRequestProgress/)
    expect(body.variables).toEqual({ promptId: 'fr1' })
    // The DAN-52 TicketProgress shape is part of the selection set, so the DAG
    // view needs no second query when the backend lands.
    for (const field of [
      'issueId',
      'identifier',
      'title',
      'state',
      'issueUrl',
      'prUrl',
      'blockedBy',
    ]) {
      expect(body.query).toContain(field)
    }
  })

  it('resolves [] when the server sends no list, so the view can always map', async () => {
    vi.stubGlobal('fetch', gqlOk({ featureRequestProgress: null }))
    await expect(featureRequestProgress('fr1')).resolves.toEqual([])
  })

  it('rejects with the execution-level error message so the view can go stale', async () => {
    vi.stubGlobal(
      'fetch',
      gqlError('feature request not found', { code: 'NOT_FOUND' }),
    )
    await expect(featureRequestProgress('missing')).rejects.toMatchObject({
      message: 'feature request not found',
      extensions: { code: 'NOT_FOUND' },
    })
  })
})
