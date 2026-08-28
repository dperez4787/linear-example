import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { languagePreference, setLanguagePreference } from './api.js'
import { getIdToken } from './auth.js'

// DAN-97: the two wire calls that back cross-device language persistence,
// against DAN-96's contract — `languagePreference: String` and
// `setLanguagePreference(language: String!): String!`, both uid-scoped from the
// token rather than from an argument. Same idiom as the other api.dan*.test.jsx
// files: fetch is stubbed and the query document is matched by field presence
// only, since formatting is a local choice and not contract.
vi.mock('./auth.js', () => ({
  getIdToken: vi.fn(async () => null),
  signOutUser: vi.fn(async () => {}),
}))

beforeEach(() => {
  vi.mocked(getIdToken).mockResolvedValue('token')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function gqlOk(data) {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data }) }))
}

function sentBody(fetchMock) {
  return JSON.parse(fetchMock.mock.calls[0][1].body)
}

describe('DAN-97 languagePreference()', () => {
  it('queries languagePreference and resolves the stored value', async () => {
    const fetchMock = gqlOk({ languagePreference: 'es' })
    vi.stubGlobal('fetch', fetchMock)

    await expect(languagePreference()).resolves.toBe('es')

    const body = sentBody(fetchMock)
    expect(body.query).toMatch(/languagePreference/)
    // The caller is identified by the token, not by a uid argument — a uid on
    // the wire would be a client-supplied identity.
    expect(body.query).not.toMatch(/uid/)
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer token')
  })

  it('resolves null when the user has never chosen one', async () => {
    vi.stubGlobal('fetch', gqlOk({ languagePreference: null }))

    await expect(languagePreference()).resolves.toBeNull()
  })

  it('throws when the server reports an execution-level error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ errors: [{ message: 'unauthenticated' }] }),
      })),
    )

    await expect(languagePreference()).rejects.toThrow('unauthenticated')
  })
})

describe('DAN-97 setLanguagePreference()', () => {
  it('sends the language as a String! variable and resolves what was stored', async () => {
    const fetchMock = gqlOk({ setLanguagePreference: 'es' })
    vi.stubGlobal('fetch', fetchMock)

    await expect(setLanguagePreference('es')).resolves.toBe('es')

    const body = sentBody(fetchMock)
    expect(body.query).toMatch(/setLanguagePreference/)
    expect(body.query).toMatch(/\$language:\s*String!/)
    expect(body.variables).toEqual({ language: 'es' })
  })

  it('throws with the offending field when the backend rejects the language', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          errors: [
            {
              message: 'language must be one of en, es',
              extensions: { code: 'BAD_USER_INPUT', field: 'language' },
            },
          ],
        }),
      })),
    )

    await expect(setLanguagePreference('fr')).rejects.toMatchObject({
      message: 'language must be one of en, es',
      field: 'language',
    })
  })
})
