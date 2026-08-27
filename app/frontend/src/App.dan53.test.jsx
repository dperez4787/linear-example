import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { listRecords } from './api.js'
import App from './App.jsx'
import { AuthProvider } from './AuthContext.jsx'
import AuthGate from './AuthGate.jsx'

// DAN-53: reaching the feature-request view from the main view and coming back,
// with no full page reload — the switch is App state, so the same React tree
// stays mounted throughout. api.js is fully mocked (components never fetch);
// auth.js is mocked the same way the AuthGate tests mock it, so the composed
// gate + App tree runs without Firebase.
vi.mock('./api.js', () => ({
  listRecords: vi.fn(async () => []),
  createRecord: vi.fn(),
  updateRecord: vi.fn(),
  deleteRecord: vi.fn(),
  startFeatureRequest: vi.fn(),
  sendFeatureRequestMessage: vi.fn(),
  featureRequest: vi.fn(),
  // DAN-54: FeatureRequestView now also imports the quota meter's query and
  // the approval mutation, so the mocked module surface must include them. The
  // meter resolves to nothing so the view skips its state update and these
  // tests stay act()-quiet.
  myAiUsage: vi.fn(async () => undefined),
  approveFeatureRequestPlan: vi.fn(),
}))

const authMock = vi.hoisted(() => ({ user: null }))

vi.mock('./auth.js', () => ({
  subscribeToAuth: vi.fn((listener) => {
    listener(authMock.user)
    return () => {}
  }),
  signInWithGoogle: vi.fn(async () => {}),
  signOutUser: vi.fn(async () => {}),
  getIdToken: vi.fn(async () => (authMock.user ? 'token' : null)),
}))

beforeEach(() => {
  authMock.user = null
  vi.mocked(listRecords).mockClear()
  vi.mocked(listRecords).mockResolvedValue([
    {
      id: 'a1',
      name: 'Alpha',
      status: 'active',
      amount: 10,
      notes: '',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    },
  ])
})

describe('DAN-53 · switching between the records table and the feature-request view', () => {
  it('opens the chat pane from the "Request a feature" control and returns via the back control', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Request a feature' }))

    // The chat pane is showing; the records table is not.
    expect(
      screen.getByRole('heading', { name: 'Request a feature' }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Message')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Back to records' }))

    // Back on the records table — and without any re-fetch: the mount request
    // is the only listRecords call, which is what "no full page reload" means
    // in a test that cannot observe the browser.
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Request a feature' }),
    ).not.toBeInTheDocument()
    expect(vi.mocked(listRecords)).toHaveBeenCalledTimes(1)
  })
})

describe('DAN-53 · the feature-request view sits behind AuthGate', () => {
  function renderGated() {
    return render(
      <AuthProvider>
        <AuthGate>
          <App />
        </AuthGate>
      </AuthProvider>,
    )
  }

  it('offers no "Request a feature" control to a signed-out user', async () => {
    authMock.user = null
    renderGated()

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /sign in with google/i }),
      ).toBeInTheDocument(),
    )
    expect(
      screen.queryByRole('button', { name: 'Request a feature' }),
    ).not.toBeInTheDocument()
  })

  it('lets a signed-in user open the chat pane inside the gate', async () => {
    authMock.user = { displayName: 'Grace Hopper', email: 'grace@example.com' }
    renderGated()

    const open = await screen.findByRole('button', { name: 'Request a feature' })
    fireEvent.click(open)

    expect(
      screen.getByRole('heading', { name: 'Request a feature' }),
    ).toBeInTheDocument()
  })
})
