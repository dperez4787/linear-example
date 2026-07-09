// Vitest setup: extend expect with jest-dom matchers (toBeInTheDocument, etc.)
// and clean up the rendered DOM between tests.
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => {
  cleanup()
})
