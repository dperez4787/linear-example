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

describe('api.listRecords', () => {
  it('unwraps { records: [...] } into a plain array', async () => {
    const records = [
      { id: 'a1', name: 'Alpha', status: 'active', amount: 10, notes: 'hi' },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ records }),
      })),
    )

    await expect(listRecords()).resolves.toEqual(records)
    // Signed out: no token, so the request is byte-for-byte the unauthenticated
    // one — a single-argument fetch with no init object.
    expect(fetch).toHaveBeenCalledWith('/api/records')
  })

  it('returns [] when the payload has no records field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
    )

    await expect(listRecords()).resolves.toEqual([])
  })

  it('throws with the server error message on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: { message: 'Internal Server Error' } }),
      })),
    )

    await expect(listRecords()).rejects.toThrow('Internal Server Error')
  })
})

describe('api.createRecord', () => {
  it('POSTs a JSON body and unwraps { record } from the 201', async () => {
    const record = {
      id: 'new1',
      name: 'Gamma',
      status: 'pending',
      amount: 42,
      notes: 'fresh',
    }
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ record }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const input = { name: 'Gamma', status: 'pending', amount: 42, notes: 'fresh' }
    await expect(createRecord(input)).resolves.toEqual(record)

    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/records')
    expect(options.method).toBe('POST')
    expect(options.headers).toMatchObject({ 'Content-Type': 'application/json' })
    expect(JSON.parse(options.body)).toEqual(input)
  })

  it('throws with the server message AND the offending field on a 400', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            message: 'amount must be a finite number greater than or equal to 0',
            field: 'amount',
          },
        }),
      })),
    )

    // The Error must carry `field` so the form can point at the right input,
    // not just show a generic banner.
    await expect(createRecord({ amount: -1 })).rejects.toMatchObject({
      message: 'amount must be a finite number greater than or equal to 0',
      field: 'amount',
    })
  })
})

describe('api.updateRecord', () => {
  it('PATCHes the id with a JSON body and unwraps { record }', async () => {
    const record = {
      id: 'a1',
      name: 'Renamed',
      status: 'pending',
      amount: 7,
      notes: 'edited',
    }
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ record }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const patch = { name: 'Renamed', status: 'pending', amount: 7, notes: 'edited' }
    await expect(updateRecord('a1', patch)).resolves.toEqual(record)

    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/records/a1')
    expect(options.method).toBe('PATCH')
    expect(options.headers).toMatchObject({ 'Content-Type': 'application/json' })
    expect(JSON.parse(options.body)).toEqual(patch)
  })

  it('throws with the server error message on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: { message: 'amount must be a finite number greater than or equal to 0' } }),
      })),
    )

    await expect(updateRecord('a1', { amount: -1 })).rejects.toThrow(
      'amount must be a finite number greater than or equal to 0',
    )
  })
})

describe('api.deleteRecord', () => {
  it('DELETEs the id and resolves on 204 (no body to parse)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(deleteRecord('a1')).resolves.toBeUndefined()

    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/records/a1')
    expect(options.method).toBe('DELETE')
  })

  it('throws with the server error message on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({ error: { message: 'record not found' } }),
      })),
    )

    await expect(deleteRecord('missing')).rejects.toThrow('record not found')
  })
})

// The token-attachment contract: when a user is signed in, every request carries
// `Authorization: Bearer <idToken>`, and that lives here in api.js — never in a
// component (see the component-source assertion in auth.test.jsx).
describe('api token attachment', () => {
  it('attaches Authorization: Bearer <token> to a GET when signed in', async () => {
    vi.mocked(getIdToken).mockResolvedValue('id-token-abc')
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ records: [] }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    await listRecords()

    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/records')
    expect(options.headers).toMatchObject({ Authorization: 'Bearer id-token-abc' })
  })

  it('attaches the token to a POST alongside Content-Type', async () => {
    vi.mocked(getIdToken).mockResolvedValue('id-token-xyz')
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ record: { id: 'n1' } }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    await createRecord({ name: 'X', status: 'active', amount: 1, notes: '' })

    const [, options] = fetchMock.mock.calls[0]
    expect(options.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer id-token-xyz',
    })
  })

  it('sends no Authorization header when no user is signed in', async () => {
    // getIdToken defaults to null (see beforeEach).
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ record: { id: 'n1' } }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    await createRecord({ name: 'X', status: 'active', amount: 1, notes: '' })

    const [, options] = fetchMock.mock.calls[0]
    expect(options.headers).not.toHaveProperty('Authorization')
  })
})

// A 401 is the backend saying "your token is missing/expired/rejected." api.js
// treats that as signed-out — it calls signOutUser(), which (via the auth
// context) returns the app to the sign-in affordance — and still throws so the
// caller unwinds. This is what makes a 401 a sign-in prompt, not an error banner.
describe('api 401 handling', () => {
  it('signs the user out on a 401 and rethrows', async () => {
    vi.mocked(getIdToken).mockResolvedValue('stale-token')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        json: async () => ({ error: { message: 'unauthorized' } }),
      })),
    )

    await expect(listRecords()).rejects.toThrow('unauthorized')
    expect(vi.mocked(signOutUser)).toHaveBeenCalledTimes(1)
  })
})
