// DAN-53 tester verification. Independent of the developer's own *.test.jsx.
// Locks the ticket's acceptance criteria:
//  - The feature-request view sits behind AuthGate: a signed-out user sees no
//    "Request a feature" control anywhere; a signed-in user opens the chat pane
//    and returns to the records table with no remount/reload (the mount fetch
//    is the only listRecords call).
//  - First submit calls startFeatureRequest BEFORE sendFeatureRequestMessage,
//    threading the id the start resolved with (a distinctive id, so an
//    accidentally hardcoded 'fr1' cannot pass).
//  - The transcript labels every message with its role, visibly: user,
//    product-owner, architect.
//  - While a send is in flight (a hanging promise the test controls) the input
//    is disabled and a busy indicator is visible; on rejection an alert
//    appears, the input re-enables, and the unsent draft survives.
//  - Convention: no fetch( in any component file — api.js is the only module
//    that talks to the network (checked by scanning the source tree).
//
// api.js is fully mocked; auth.js is mocked the way the AuthGate suites mock
// it. Everything is asserted via roles and accessible text, never styles.
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { listRecords, sendFeatureRequestMessage, startFeatureRequest } from './api.js'
import App from './App.jsx'
import { AuthProvider } from './AuthContext.jsx'
import AuthGate from './AuthGate.jsx'

vi.mock('./api.js', () => ({
  listRecords: vi.fn(),
  createRecord: vi.fn(),
  updateRecord: vi.fn(),
  deleteRecord: vi.fn(),
  startFeatureRequest: vi.fn(),
  sendFeatureRequestMessage: vi.fn(),
  featureRequest: vi.fn(),
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

const ROWS = [
  {
    id: 'a1',
    name: 'Alpha',
    status: 'active',
    amount: 10,
    notes: 'note a',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  },
  {
    id: 'b2',
    name: 'Beta',
    status: 'pending',
    amount: 5,
    notes: '',
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
  },
]

// A distinctive id: if the component hardcodes an id instead of threading the
// one startFeatureRequest resolved with, the send assertion fails.
const STARTED_ID = 'fr-tester-77'

function makeRequest(messages = []) {
  return {
    id: STARTED_ID,
    status: 'open',
    model: 'claude-opus-5',
    createdAt: '2026-08-26T00:00:00.000Z',
    messages,
  }
}

function deferred() {
  let resolve_, reject_
  const promise = new Promise((res, rej) => {
    resolve_ = res
    reject_ = rej
  })
  return { promise, resolve: resolve_, reject: reject_ }
}

function renderGated() {
  return render(
    <AuthProvider>
      <AuthGate>
        <App />
      </AuthGate>
    </AuthProvider>,
  )
}

function composerInput() {
  return screen.getByLabelText('Message')
}

function typeAndSend(text) {
  fireEvent.change(composerInput(), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
}

beforeEach(() => {
  authMock.user = null
  vi.mocked(listRecords).mockReset()
  vi.mocked(startFeatureRequest).mockReset()
  vi.mocked(sendFeatureRequestMessage).mockReset()
  vi.mocked(listRecords).mockResolvedValue(ROWS)
})

describe('DAN-53 tester · AuthGate boundary', () => {
  it('a signed-out user sees no "Request a feature" control anywhere', async () => {
    authMock.user = null
    renderGated()

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /sign in with google/i }),
      ).toBeInTheDocument(),
    )
    expect(
      screen.queryByRole('button', { name: /request a feature/i }),
    ).not.toBeInTheDocument()
    // Nothing of the chat pane leaks past the gate either.
    expect(
      screen.queryByRole('heading', { name: /request a feature/i }),
    ).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument()
    // And no records were fetched for a signed-out user’s tree.
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})

describe('DAN-53 tester · open → back round trip without a reload', () => {
  it('opens the chat pane and returns to the intact records table with exactly one records fetch', async () => {
    authMock.user = { displayName: 'Ada Lovelace', email: 'ada@example.com' }
    renderGated()

    // Records view mounted inside the gate.
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(vi.mocked(listRecords)).toHaveBeenCalledTimes(1)

    // Open the feature-request view.
    fireEvent.click(screen.getByRole('button', { name: 'Request a feature' }))
    expect(
      screen.getByRole('heading', { name: 'Request a feature' }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Message')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()

    // Back to the records table.
    fireEvent.click(screen.getByRole('button', { name: 'Back to records' }))
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Request a feature' }),
    ).not.toBeInTheDocument()

    // "Without a full page reload": the same App instance stayed mounted, so
    // the mount-time fetch is the only listRecords call in the whole trip.
    expect(vi.mocked(listRecords)).toHaveBeenCalledTimes(1)
  })
})

describe('DAN-53 tester · first submit orders start before send and threads the id', () => {
  it('calls startFeatureRequest, then sendFeatureRequestMessage with the id the start resolved with', async () => {
    authMock.user = { displayName: 'Ada Lovelace' }
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
      makeRequest([{ role: 'user', content: 'Add CSV export' }]),
    )
    renderGated()
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Request a feature' }))

    typeAndSend('Add CSV export')

    await waitFor(() =>
      expect(sendFeatureRequestMessage).toHaveBeenCalledWith(
        STARTED_ID,
        'Add CSV export',
      ),
    )
    expect(startFeatureRequest).toHaveBeenCalledTimes(1)
    expect(sendFeatureRequestMessage).toHaveBeenCalledTimes(1)
    // start was invoked strictly before send.
    expect(
      vi.mocked(startFeatureRequest).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(sendFeatureRequestMessage).mock.invocationCallOrder[0],
    )
  })
})

describe('DAN-53 tester · transcript role labels', () => {
  it('shows the user message and each reply, each visibly labeled with its role', async () => {
    authMock.user = { displayName: 'Ada Lovelace' }
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
      makeRequest([
        { role: 'user', content: 'Add CSV export' },
        { role: 'product-owner', content: 'Slicing this into a ticket' },
        { role: 'architect', content: 'Stream it from the backend' },
      ]),
    )
    renderGated()
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Request a feature' }))

    typeAndSend('Add CSV export')

    const transcript = await screen.findByRole('list', { name: 'Conversation' })
    const items = within(transcript).getAllByRole('listitem')
    expect(items).toHaveLength(3)
    // Each message carries its role as visible text alongside its content.
    expect(within(items[0]).getByText('user')).toBeInTheDocument()
    expect(within(items[0]).getByText('Add CSV export')).toBeInTheDocument()
    expect(within(items[1]).getByText('product-owner')).toBeInTheDocument()
    expect(
      within(items[1]).getByText('Slicing this into a ticket'),
    ).toBeInTheDocument()
    expect(within(items[2]).getByText('architect')).toBeInTheDocument()
    expect(
      within(items[2]).getByText('Stream it from the backend'),
    ).toBeInTheDocument()
  })
})

describe('DAN-53 tester · in-flight state', () => {
  it('disables the input and shows a busy indicator while the send hangs, then clears both', async () => {
    authMock.user = { displayName: 'Ada Lovelace' }
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    const d = deferred()
    vi.mocked(sendFeatureRequestMessage).mockReturnValue(d.promise)
    renderGated()
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Request a feature' }))

    typeAndSend('Add CSV export')

    // The promise is hanging: busy indicator visible, composer disabled.
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument())
    expect(composerInput()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()

    d.resolve(makeRequest([{ role: 'user', content: 'Add CSV export' }]))

    await waitFor(() =>
      expect(screen.queryByRole('status')).not.toBeInTheDocument(),
    )
    expect(composerInput()).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()
  })
})

describe('DAN-53 tester · API rejection', () => {
  it('shows an alert, re-enables the input, and keeps the unsent draft', async () => {
    authMock.user = { displayName: 'Ada Lovelace' }
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    const d = deferred()
    vi.mocked(sendFeatureRequestMessage).mockReturnValue(d.promise)
    renderGated()
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Request a feature' }))

    typeAndSend('Add CSV export')
    await waitFor(() => expect(composerInput()).toBeDisabled())

    d.reject(new Error('Internal Server Error'))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Internal Server Error')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(composerInput()).toBeEnabled()
    // The draft survived the failure — the app did not eat the input.
    expect(composerInput()).toHaveValue('Add CSV export')
  })
})

describe('DAN-53 tester · convention: api.js is the only fetch site', () => {
  it('no component or non-test source file contains fetch( except api.js', () => {
    const srcDir = resolve(process.cwd(), 'src')
    const offenders = readdirSync(srcDir)
      .filter((f) => /\.(js|jsx)$/.test(f))
      .filter((f) => !/\.test\.jsx?$/.test(f))
      .filter((f) => f !== 'api.js')
      .filter((f) => /\bfetch\s*\(/.test(readFileSync(resolve(srcDir, f), 'utf8')))
    expect(offenders).toEqual([])
  })
})
