import { StrictMode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import App from './App.jsx'
import * as api from './api.js'

// Mount App the way main.jsx mounts it — inside <StrictMode> — so these tests
// exercise the real double-invoked-effect path in dev, not a StrictMode-free
// render the app never uses.
function renderApp() {
  return render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

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

    renderApp()

    expect(await screen.findByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
    // Fetched exactly once even though StrictMode double-invokes the effect.
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('renders a visible empty state when there are no records', async () => {
    vi.spyOn(api, 'listRecords').mockResolvedValue([])

    renderApp()

    expect(await screen.findByText('No records yet.')).toBeInTheDocument()
  })

  it('shows an error message when the fetch fails', async () => {
    vi.spyOn(api, 'listRecords').mockRejectedValue(new Error('boom'))

    renderApp()

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('boom')
    })
  })
})
