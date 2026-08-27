// Vitest setup: extend expect with jest-dom matchers (toBeInTheDocument, etc.)
// and clean up the rendered DOM between tests.
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => {
  cleanup()
  // DAN-82: App parses location.pathname at mount and navigation pushes real
  // history entries, so a test that clicks through the app moves the jsdom
  // URL. Put it back to `/` between tests — replaceState (not pushState) so
  // the reset itself never grows the history stack or fires popstate.
  window.history.replaceState(null, '', '/')
})
