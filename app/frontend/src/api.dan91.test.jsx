import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  featureRequest,
  listFeatureRequests,
  startFeatureRequest,
} from './api.js'
import { getIdToken } from './auth.js'

// DAN-91: `title` — DAN-90's generated snake_case slug — joins the
// FeatureRequest selection set, so every operation that resolves a
// FeatureRequest carries it and no surface needs a second query. Same idiom as
// api.dan81.test.jsx: fetch is stubbed and the query document is matched by
// field presence only (formatting is a local choice, not contract).
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

function gqlOk(data) {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data }) }))
}

function requestPayload(overrides = {}) {
  return {
    id: 'fr1',
    status: 'building',
    model: 'claude-opus-5',
    createdAt: '2026-08-27T00:00:00.000Z',
    approvable: false,
    linearProjectUrl: null,
    title: 'change_buttons_to_green',
    messages: [],
    entranceCriteria: null,
    ...overrides,
  }
}

describe('DAN-91 FeatureRequest selection set', () => {
  it('requests title on every FeatureRequest operation (schema-forward on DAN-90)', async () => {
    const cases = [
      ['startFeatureRequest', () => startFeatureRequest('claude-opus-5'), {
        startFeatureRequest: requestPayload(),
      }],
      ['featureRequests', () => listFeatureRequests(), {
        featureRequests: [requestPayload()],
      }],
      ['featureRequest', () => featureRequest('fr1'), {
        featureRequest: requestPayload(),
      }],
    ]

    for (const [, call, data] of cases) {
      const fetchMock = gqlOk(data)
      vi.stubGlobal('fetch', fetchMock)
      await call()
      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      expect(body.query).toContain('title')
      vi.unstubAllGlobals()
    }
  })

  it('passes the slug through untouched, and null through as null', async () => {
    vi.stubGlobal(
      'fetch',
      gqlOk({
        featureRequests: [
          requestPayload({ id: 'a', title: 'change_buttons_to_green' }),
          requestPayload({ id: 'b', title: null }),
        ],
      }),
    )

    const list = await listFeatureRequests()
    expect(list.map((r) => r.title)).toEqual(['change_buttons_to_green', null])
  })
})
