import { afterEach, describe, expect, it, vi } from 'vitest'

import { listRecords } from './api.js'

describe('api.listRecords', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('unwraps { records: [...] } into a plain array', async () => {
    const records = [
      { id: 'a1', name: 'Alpha', status: 'active', amount: 10, notes: 'hi' },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ records }),
      })),
    )

    await expect(listRecords()).resolves.toEqual(records)
    expect(fetch).toHaveBeenCalledWith('/api/records')
  })

  it('returns [] when the payload has no records field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
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
