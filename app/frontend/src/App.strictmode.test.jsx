import { StrictMode } from 'react'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import App from './App.jsx'
import * as api from './api.js'

// DAN-8 tester: the app runs inside <StrictMode> in production of main.jsx.
// Criterion 2 requires the records be fetched exactly once on mount. StrictMode
// double-invokes effects in dev, so this measures the real call count the way
// the app actually mounts — not the StrictMode-free render the dev's own test used.
describe('App under StrictMode (as main.jsx mounts it)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fetches records exactly once on mount', async () => {
    const records = [
      { id: 'a1', name: 'Alpha', status: 'active', amount: 10, notes: 'note a' },
    ]
    const spy = vi.spyOn(api, 'listRecords').mockResolvedValue(records)

    render(
      <StrictMode>
        <App />
      </StrictMode>,
    )

    expect(await screen.findByText('Alpha')).toBeInTheDocument()
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
