import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  approveFeatureRequestPlan,
  featureRequest,
  featureRequestProgress,
  listFeatureRequests,
  listRecords,
  sendFeatureRequestMessage,
  startFeatureRequest,
} from './api.js'
import App, { parseRoute } from './App.jsx'
import { AuthProvider } from './AuthContext.jsx'
import AuthGate from './AuthGate.jsx'

// DAN-82: History-API routing — real URLs for the three views, no router
// dependency. `/` is the records table, `/requests` the request-a-feature
// surface with the DAN-74 list, `/requests/:id` one session (chat while
// gathering, the DAN-55 DAG once building). In-app transitions go through
// pushState (no reload — asserted the DAN-53 way, via listRecords call
// counts); back/forward are exercised by stubbing the traversal: restore the
// URL with replaceState and dispatch popstate, which is exactly the browser
// contract App subscribes to. Deep links parse location.pathname at mount.
// api.js fully mocked as in every App suite.
vi.mock('./api.js', () => ({
  listRecords: vi.fn(),
  createRecord: vi.fn(),
  updateRecord: vi.fn(),
  deleteRecord: vi.fn(),
  startFeatureRequest: vi.fn(),
  sendFeatureRequestMessage: vi.fn(),
  featureRequest: vi.fn(),
  listFeatureRequests: vi.fn(),
  myAiUsage: vi.fn(async () => undefined),
  approveFeatureRequestPlan: vi.fn(),
  featureRequestProgress: vi.fn(),
  featureRequestCost: vi.fn(),
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

const RECORD = {
  id: 'a1',
  name: 'Alpha',
  status: 'active',
  amount: 10,
  notes: '',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
}

// A persisted gathering session, reachable by deep link and from the list.
const gatheringRequest = {
  id: 'fr-g',
  status: 'gathering',
  model: 'gpt-5.6-terra',
  createdAt: '2026-08-27T10:00:00.000Z',
  messages: [
    { role: 'user', content: 'Add CSV export to the records table' },
    { role: 'product-owner', content: 'Which columns should the export include?' },
  ],
  entranceCriteria: null,
  approvable: false,
  linearProjectUrl: null,
}

// A persisted approved session, already building.
const buildingRequest = {
  ...gatheringRequest,
  id: 'fr-b',
  status: 'building',
  model: 'claude-opus-5',
  createdAt: '2026-08-26T09:00:00.000Z',
  messages: [{ role: 'user', content: 'Nightly usage report' }],
}

// Mount the app at a path, the way a deep link cold-loads the SPA (Firebase
// Hosting rewrites ** to the same bundle): set the URL first, then render.
function renderAt(path) {
  window.history.replaceState(null, '', path)
  return render(<App />)
}

// Browser back/forward, stubbed at the contract App subscribes to: the
// browser moves the URL, then fires popstate.
function traverseTo(path) {
  act(() => {
    window.history.replaceState(null, '', path)
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
}

beforeEach(() => {
  authMock.user = null
  vi.mocked(listRecords).mockReset().mockResolvedValue([RECORD])
  vi.mocked(startFeatureRequest).mockReset()
  vi.mocked(sendFeatureRequestMessage).mockReset()
  vi.mocked(featureRequest).mockReset()
  vi.mocked(listFeatureRequests).mockReset().mockResolvedValue([
    gatheringRequest,
    buildingRequest,
  ])
  vi.mocked(approveFeatureRequestPlan).mockReset()
  vi.mocked(featureRequestProgress).mockReset().mockResolvedValue([])
})

describe('DAN-82 · parseRoute', () => {
  it('maps the three known paths', () => {
    expect(parseRoute('/')).toEqual({ view: 'records', requestId: null })
    expect(parseRoute('/requests')).toEqual({
      view: 'feature-request',
      requestId: null,
    })
    expect(parseRoute('/requests/')).toEqual({
      view: 'feature-request',
      requestId: null,
    })
    expect(parseRoute('/requests/fr-42')).toEqual({
      view: 'feature-request',
      requestId: 'fr-42',
    })
    expect(parseRoute('/requests/fr-42/')).toEqual({
      view: 'feature-request',
      requestId: 'fr-42',
    })
  })

  it('percent-decodes the id and survives a malformed escape', () => {
    expect(parseRoute('/requests/fr%2042').requestId).toBe('fr 42')
    // A hand-typed broken escape must not throw — the raw segment is kept.
    expect(parseRoute('/requests/fr%zz').requestId).toBe('fr%zz')
  })

  it('falls back to the records view for unknown paths', () => {
    expect(parseRoute('/nope').view).toBe('records')
    expect(parseRoute('/requests/fr-1/extra').view).toBe('records')
    expect(parseRoute('/requestsabc').view).toBe('records')
  })
})

describe('DAN-82 · path picks the view at mount', () => {
  it('renders the records table at /', async () => {
    renderAt('/')
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
    expect(
      screen.queryByRole('heading', { name: 'Request a feature' }),
    ).not.toBeInTheDocument()
  })

  it('renders the request-a-feature surface with the My-requests list at /requests', async () => {
    renderAt('/requests')
    expect(
      screen.getByRole('heading', { name: 'Request a feature' }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Message')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    const list = screen.getByRole('region', { name: 'My requests' })
    expect(
      await within(list).findByText(/Add CSV export to the records table/),
    ).toBeInTheDocument()
  })

  it('falls back to the records view for an unknown path', async () => {
    renderAt('/definitely/not-a-route')
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
  })
})

describe('DAN-82 · deep links load the session directly', () => {
  it('reopens a gathering session at /requests/:id into the chat, picker locked to its model', async () => {
    vi.mocked(featureRequest).mockResolvedValue(gatheringRequest)
    renderAt('/requests/fr-g')

    // Fetched by id and adopted via the DAN-74 path.
    await waitFor(() => expect(featureRequest).toHaveBeenCalledWith('fr-g'))
    const transcript = await screen.findByRole('list', { name: 'Conversation' })
    expect(
      within(transcript).getByText('Which columns should the export include?'),
    ).toBeInTheDocument()

    // The locked picker shows the session's own model.
    const radio = screen.getByRole('radio', { name: 'gpt-5.6-terra' })
    expect(radio).toBeChecked()
    expect(radio).toBeDisabled()

    // A session URL shows the session, not the list or the records table.
    expect(
      screen.queryByRole('region', { name: 'My requests' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('reopens a building session at /requests/:id straight into the build DAG', async () => {
    vi.mocked(featureRequest).mockResolvedValue(buildingRequest)
    renderAt('/requests/fr-b')

    await screen.findByRole('region', { name: 'Build progress' })
    await waitFor(() =>
      expect(featureRequestProgress).toHaveBeenCalledWith('fr-b'),
    )
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument()
  })

  it('browser back from a deep-linked session returns to the prior view', async () => {
    vi.mocked(featureRequest).mockResolvedValue(gatheringRequest)
    renderAt('/requests/fr-g')
    await screen.findByRole('list', { name: 'Conversation' })

    traverseTo('/requests')

    // The fresh surface: live empty composer, list back, transcript gone.
    expect(
      screen.queryByRole('list', { name: 'Conversation' }),
    ).not.toBeInTheDocument()
    expect(screen.getByLabelText('Message')).toHaveValue('')
    expect(
      await screen.findByRole('region', { name: 'My requests' }),
    ).toBeInTheDocument()

    traverseTo('/')
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
  })
})

describe('DAN-82 · in-app navigation uses pushState, never a reload', () => {
  it('Request a feature ⇄ back moves the URL with one records fetch for the whole trip', async () => {
    renderAt('/')
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Request a feature' }))
    expect(window.location.pathname).toBe('/requests')
    expect(
      screen.getByRole('heading', { name: 'Request a feature' }),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Back to records' }))
    expect(window.location.pathname).toBe('/')
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByText('Alpha')).toBeInTheDocument()

    // "No reload": the same App instance stayed mounted throughout, so the
    // mount-time fetch is the only listRecords call of the whole trip.
    expect(vi.mocked(listRecords)).toHaveBeenCalledTimes(1)
  })

  it('browser back after in-app navigation returns to the records view without a refetch', async () => {
    renderAt('/')
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Request a feature' }))
    expect(screen.queryByRole('table')).not.toBeInTheDocument()

    traverseTo('/')

    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(vi.mocked(listRecords)).toHaveBeenCalledTimes(1)
  })

  it('clicking a My-requests entry pushes /requests/:id and adopts without refetching', async () => {
    renderAt('/requests')
    const list = screen.getByRole('region', { name: 'My requests' })
    await within(list).findAllByRole('button')

    fireEvent.click(
      screen.getByRole('button', { name: /Add CSV export to the records table/ }),
    )

    // pushState navigation: the URL is the session's, with no reload and no
    // second fetch — the list already had the full request to adopt.
    expect(window.location.pathname).toBe('/requests/fr-g')
    const transcript = screen.getByRole('list', { name: 'Conversation' })
    expect(
      within(transcript).getByText('Which columns should the export include?'),
    ).toBeInTheDocument()
    expect(featureRequest).not.toHaveBeenCalled()
  })
})

describe('DAN-82 · approval pushes the session URL', () => {
  it('approving pushes /requests/:id onto history; back returns to the pre-approval surface', async () => {
    const started = {
      ...gatheringRequest,
      id: 'fr-new',
      model: 'claude-opus-5',
      messages: [],
    }
    vi.mocked(startFeatureRequest).mockResolvedValue(started)
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue({
      ...started,
      messages: [
        { role: 'user', content: 'A concrete idea' },
        { role: 'product-owner', content: 'Ready to approve.' },
      ],
      approvable: true,
    })
    vi.mocked(approveFeatureRequestPlan).mockResolvedValue({
      ...started,
      status: 'building',
      approvable: false,
    })

    renderAt('/')
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Request a feature' }))

    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: 'A concrete idea' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Approve plan' })).toBeEnabled(),
    )
    expect(window.location.pathname).toBe('/requests')

    const pushSpy = vi.spyOn(window.history, 'pushState')
    fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }))

    // A real history push of the session URL, and the hand-off view mounts —
    // from in-memory state, not a refetch.
    await screen.findByRole('region', { name: 'Build progress' })
    expect(pushSpy).toHaveBeenCalledWith(null, '', '/requests/fr-new')
    expect(window.location.pathname).toBe('/requests/fr-new')
    expect(featureRequest).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(featureRequestProgress).toHaveBeenCalledWith('fr-new'),
    )
    pushSpy.mockRestore()

    // Browser back: the pre-approval surface (fresh composer + list) returns.
    traverseTo('/requests')
    expect(
      screen.queryByRole('region', { name: 'Build progress' }),
    ).not.toBeInTheDocument()
    expect(screen.getByLabelText('Message')).toBeInTheDocument()
    expect(
      await screen.findByRole('region', { name: 'My requests' }),
    ).toBeInTheDocument()
  })
})

describe('DAN-82 · AuthGate still fronts every path', () => {
  it('a signed-out deep link to /requests/:id shows sign-in and loads nothing', async () => {
    authMock.user = null
    window.history.replaceState(null, '', '/requests/fr-g')
    render(
      <AuthProvider>
        <AuthGate>
          <App />
        </AuthGate>
      </AuthProvider>,
    )

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /sign in with google/i }),
      ).toBeInTheDocument(),
    )
    expect(
      screen.queryByRole('heading', { name: 'Request a feature' }),
    ).not.toBeInTheDocument()
    expect(featureRequest).not.toHaveBeenCalled()
  })

  it('a signed-in deep link renders the session inside the gate', async () => {
    authMock.user = { displayName: 'Grace Hopper', email: 'grace@example.com' }
    vi.mocked(featureRequest).mockResolvedValue(gatheringRequest)
    window.history.replaceState(null, '', '/requests/fr-g')
    render(
      <AuthProvider>
        <AuthGate>
          <App />
        </AuthGate>
      </AuthProvider>,
    )

    const transcript = await screen.findByRole('list', { name: 'Conversation' })
    expect(
      within(transcript).getByText('Add CSV export to the records table'),
    ).toBeInTheDocument()
  })
})
