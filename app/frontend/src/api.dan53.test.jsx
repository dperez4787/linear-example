import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { featureRequest, sendFeatureRequestMessage, startFeatureRequest } from './api.js'
import { getIdToken } from './auth.js'

// DAN-53: the feature-request surface of api.js. Same idiom as api.test.jsx —
// fetch is stubbed, each call is asserted to be one POST to /api/graphql with
// the right variables, and the query document is matched by operation name only
// (its formatting is a local choice, not contract). auth.js is mocked so no
// Firebase is involved; default is signed-out.
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
  return { url, method: options.method, headers: options.headers, body: JSON.parse(options.body) }
}

// A wire-shaped FeatureRequest, as the backend returns it.
function makeRequest(messages = []) {
  return {
    id: 'fr1',
    status: 'open',
    model: 'claude-opus-5',
    createdAt: '2026-08-26T00:00:00.000Z',
    messages,
  }
}

describe('api.startFeatureRequest', () => {
  it('POSTs one startFeatureRequest mutation with the model in the input variable', async () => {
    const created = makeRequest()
    const fetchMock = gqlOk({ startFeatureRequest: created })
    vi.stubGlobal('fetch', fetchMock)

    await expect(startFeatureRequest('claude-opus-5')).resolves.toEqual(created)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const call = calledWith(fetchMock)
    expect(call.url).toBe('/api/graphql')
    expect(call.method).toBe('POST')
    expect(call.body.query).toMatch(/startFeatureRequest/)
    expect(call.body.variables).toEqual({ input: { model: 'claude-opus-5' } })
  })

  it('throws with the server message on an execution-level error', async () => {
    vi.stubGlobal('fetch', gqlError('model is required', { code: 'BAD_USER_INPUT', field: 'model' }))
    await expect(startFeatureRequest('')).rejects.toMatchObject({
      message: 'model is required',
      field: 'model',
    })
  })
})

describe('api.sendFeatureRequestMessage', () => {
  it('POSTs one sendFeatureRequestMessage mutation with id and content variables and resolves the updated request', async () => {
    const updated = makeRequest([
      { role: 'user', content: 'Please add CSV export' },
      { role: 'product-owner', content: 'Sliced into a ticket' },
      { role: 'architect', content: 'Stream it from the backend' },
    ])
    const fetchMock = gqlOk({ sendFeatureRequestMessage: updated })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      sendFeatureRequestMessage('fr1', 'Please add CSV export'),
    ).resolves.toEqual(updated)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const call = calledWith(fetchMock)
    expect(call.url).toBe('/api/graphql')
    expect(call.method).toBe('POST')
    expect(call.body.query).toMatch(/sendFeatureRequestMessage/)
    expect(call.body.variables).toEqual({ id: 'fr1', content: 'Please add CSV export' })
  })

  it('throws with the server message on a not-found error', async () => {
    vi.stubGlobal('fetch', gqlError('feature request not found', { code: 'NOT_FOUND' }))
    await expect(sendFeatureRequestMessage('missing', 'hi')).rejects.toThrow(
      'feature request not found',
    )
  })
})

describe('api.featureRequest', () => {
  it('POSTs one featureRequest query with the id variable and resolves the request', async () => {
    const request = makeRequest([{ role: 'user', content: 'hello' }])
    const fetchMock = gqlOk({ featureRequest: request })
    vi.stubGlobal('fetch', fetchMock)

    await expect(featureRequest('fr1')).resolves.toEqual(request)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const call = calledWith(fetchMock)
    expect(call.url).toBe('/api/graphql')
    expect(call.method).toBe('POST')
    expect(call.body.query).toMatch(/featureRequest/)
    expect(call.body.variables).toEqual({ id: 'fr1' })
  })

  it('throws with the server message on a not-found error', async () => {
    vi.stubGlobal('fetch', gqlError('feature request not found', { code: 'NOT_FOUND' }))
    await expect(featureRequest('missing')).rejects.toThrow('feature request not found')
  })
})

describe('feature-request token attachment', () => {
  it('attaches Authorization: Bearer <token> when signed in', async () => {
    vi.mocked(getIdToken).mockResolvedValue('id-token-53')
    const fetchMock = gqlOk({ startFeatureRequest: makeRequest() })
    vi.stubGlobal('fetch', fetchMock)

    await startFeatureRequest('claude-opus-5')

    const call = calledWith(fetchMock)
    expect(call.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer id-token-53',
    })
  })
})
