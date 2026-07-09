import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import App from './App.jsx'
import * as api from './api.js'

describe('App', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fetches records once on mount and renders a row per record', async () => {
    const records = [
      { id: 'a1', name: 'Alpha', status: 'active', amount: 10, notes: 'note a' },
      { id: 'b2', name: 'Beta', status: 'archived', amount: 5, notes: '' },
    ]
    const spy = vi.spyOn(api, 'listRecords').mockResolvedValue(records)

    render(<App />)

    expect(await screen.findByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
    // Fetched exactly once (StrictMode is not enabled in this render).
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('renders a visible empty state when there are no records', async () => {
    vi.spyOn(api, 'listRecords').mockResolvedValue([])

    render(<App />)

    expect(await screen.findByText('No records yet.')).toBeInTheDocument()
  })

  it('shows an error message when the fetch fails', async () => {
    vi.spyOn(api, 'listRecords').mockRejectedValue(new Error('boom'))

    render(<App />)

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('boom')
    })
  })
})
