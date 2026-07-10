import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createRecord, deleteRecord, listRecords, updateRecord } from './api.js'
import { getIdToken, signOutUser } from './auth.js'

// api.js talks to Firebase Auth only through ./auth.js, so mocking that module
// lets these unit tests drive "signed in" vs "signed out" without ever touching
// the Firebase SDK. Default is signed-out (getIdToken -> null); individual tests
// opt into a token.
vi.mock('./auth.js', () => ({
  getIdToken: vi.fn(async () => null),
  signOutUser: vi.fn(async () => {}),
}))

beforeEach(() => {
  vi.mocked(getIdToken).mockResolvedValue(null)
  vi.mocked(signOutUser).mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// --- response builders for the GraphQL transport ---

// A successful GraphQL response: HTTP 200 with { data }.
function gqlOk(data) {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data }) }))
}

// An execution-level GraphQL error: HTTP 200 with a non-empty errors array (and
// null data). This is how validation and not-found now travel — inside the body,
// not as an HTTP 4xx.
function gqlError(message, extensions) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: null, errors: [{ message, extensions }] }),
  }))
}

// An HTTP-level error (gate 401, malformed request): non-2xx with the Express
// middleware's { error: { message, field? } } shape. Never enters GraphQL.
function httpError(status, error) {
  return vi.fn(async () => ({ ok: false, status, json: async () => ({ error }) }))
}

// Parse the single fetch call into { url, method, body } for assertions.
function calledWith(fetchMock) {
  const [url, options] = fetchMock.mock.calls[0]
  return { url, method: options.method, headers: options.headers, body: JSON.parse(options.body) }
}

describe('api.listRecords', () => {
  it('POSTs a records query to /api/graphql and unwraps data.records', async () => {
    const records = [{ id: 'a1', name: 'Alpha', status: 'active', amount: 10, notes: 'hi' }]
    const fetchMock = gqlOk({ records })
    vi.stubGlobal('fetch', fetchMock)

    await expect(listRecords()).resolves.toEqual(records)

    const call = calledWith(fetchMock)
    expect(call.url).toBe('/api/graphql')
    expect(call.method).toBe('POST')
    // The operation is a records query — asserted by name, not by byte-matching the
    // whole document (its formatting is a local choice, not contract).
    expect(call.body.query).toMatch(/records/)
  })

  it('returns [] when data.records is null/absent', async () => {
    vi.stubGlobal('fetch', gqlOk({ records: null }))
    await expect(listRecords()).resolves.toEqual([])
  })

  it('throws with the server error message on an HTTP-level failure', async () => {
    vi.stubGlobal('fetch', httpError(500, { message: 'Internal Server Error' }))
    await expect(listRecords()).rejects.toThrow('Internal Server Error')
  })
})

describe('api.createRecord', () => {
  it('sends the record as the input variable and unwraps data.createRecord', async () => {
    const record = { id: 'new1', name: 'Gamma', status: 'pending', amount: 42, notes: 'fresh' }
    const fetchMock = gqlOk({ createRecord: record })
    vi.stubGlobal('fetch', fetchMock)

    const input = { name: 'Gamma', status: 'pending', amount: 42, notes: 'fresh' }
    await expect(createRecord(input)).resolves.toEqual(record)

    const call = calledWith(fetchMock)
    expect(call.url).toBe('/api/graphql')
    expect(call.method).toBe('POST')
    expect(call.headers).toMatchObject({ 'Content-Type': 'application/json' })
    expect(call.body.query).toMatch(/createRecord/)
    // The whole record travels as the `input` variable.
    expect(call.body.variables).toEqual({ input })
  })

  it('throws with the server message AND the offending field on a validation error', async () => {
    vi.stubGlobal(
      'fetch',
      gqlError('amount must be a finite number greater than or equal to 0', {
        code: 'BAD_USER_INPUT',
        field: 'amount',
      }),
    )

    // The Error must carry `field` (read from extensions.field) so the form can
    // point at the right input, not just show a generic banner.
    await expect(createRecord({ amount: -1 })).rejects.toMatchObject({
      message: 'amount must be a finite number greater than or equal to 0',
      field: 'amount',
    })
  })
})

describe('api.updateRecord', () => {
  it('sends id and input variables and unwraps data.updateRecord', async () => {
    const record = { id: 'a1', name: 'Renamed', status: 'pending', amount: 7, notes: 'edited' }
    const fetchMock = gqlOk({ updateRecord: record })
    vi.stubGlobal('fetch', fetchMock)

    const patch = { name: 'Renamed', status: 'pending', amount: 7, notes: 'edited' }
    await expect(updateRecord('a1', patch)).resolves.toEqual(record)

    const call = calledWith(fetchMock)
    expect(call.url).toBe('/api/graphql')
    expect(call.method).toBe('POST')
    expect(call.body.query).toMatch(/updateRecord/)
    expect(call.body.variables).toEqual({ id: 'a1', input: patch })
  })

  it('throws with the server error message on a validation error', async () => {
    vi.stubGlobal(
      'fetch',
      gqlError('amount must be a finite number greater than or equal to 0', {
        code: 'BAD_USER_INPUT',
        field: 'amount',
      }),
    )
    await expect(updateRecord('a1', { amount: -1 })).rejects.toThrow(
      'amount must be a finite number greater than or equal to 0',
    )
  })
})

describe('api.deleteRecord', () => {
  it('sends the id variable and resolves undefined on success', async () => {
    const fetchMock = gqlOk({ deleteRecord: 'a1' })
    vi.stubGlobal('fetch', fetchMock)

    await expect(deleteRecord('a1')).resolves.toBeUndefined()

    const call = calledWith(fetchMock)
    expect(call.url).toBe('/api/graphql')
    expect(call.method).toBe('POST')
    expect(call.body.query).toMatch(/deleteRecord/)
    expect(call.body.variables).toEqual({ id: 'a1' })
  })

  it('throws with the server error message on a not-found error', async () => {
    vi.stubGlobal('fetch', gqlError('record not found', { code: 'NOT_FOUND' }))
    await expect(deleteRecord('missing')).rejects.toThrow('record not found')
  })
})

// The token-attachment contract: when a user is signed in, every request carries
// `Authorization: Bearer <idToken>`, and that lives here in api.js — never in a
// component (see the component-source assertion in auth.test.jsx).
describe('api token attachment', () => {
  it('attaches Authorization: Bearer <token> to the GraphQL POST when signed in', async () => {
    vi.mocked(getIdToken).mockResolvedValue('id-token-abc')
    const fetchMock = gqlOk({ records: [] })
    vi.stubGlobal('fetch', fetchMock)

    await listRecords()

    const call = calledWith(fetchMock)
    expect(call.url).toBe('/api/graphql')
    expect(call.headers).toMatchObject({ Authorization: 'Bearer id-token-abc' })
  })

  it('attaches the token alongside Content-Type on a mutation', async () => {
    vi.mocked(getIdToken).mockResolvedValue('id-token-xyz')
    const fetchMock = gqlOk({ createRecord: { id: 'n1' } })
    vi.stubGlobal('fetch', fetchMock)

    await createRecord({ name: 'X', status: 'active', amount: 1, notes: '' })

    const call = calledWith(fetchMock)
    expect(call.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer id-token-xyz',
    })
  })

  it('sends no Authorization header when no user is signed in', async () => {
    // getIdToken defaults to null (see beforeEach).
    const fetchMock = gqlOk({ createRecord: { id: 'n1' } })
    vi.stubGlobal('fetch', fetchMock)

    await createRecord({ name: 'X', status: 'active', amount: 1, notes: '' })

    const call = calledWith(fetchMock)
    expect(call.headers).not.toHaveProperty('Authorization')
  })
})

// A 401 is the backend saying "your token is missing/expired/rejected." It is an
// HTTP-level error from the auth gate — it never enters GraphQL — so the DAN-23
// sign-out-on-401 behavior carries over unchanged: api.js calls signOutUser()
// (which returns the app to the sign-in affordance) and still throws.
describe('api 401 handling', () => {
  it('signs the user out on a 401 and rethrows', async () => {
    vi.mocked(getIdToken).mockResolvedValue('stale-token')
    vi.stubGlobal('fetch', httpError(401, { message: 'unauthorized' }))

    await expect(listRecords()).rejects.toThrow('unauthorized')
    expect(vi.mocked(signOutUser)).toHaveBeenCalledTimes(1)
  })
})
