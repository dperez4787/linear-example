import { afterEach, describe, expect, it, vi } from 'vitest'

import { deleteRecord, listRecords, updateRecord } from './api.js'

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

describe('api.updateRecord', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

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
  afterEach(() => {
    vi.unstubAllGlobals()
  })

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
