import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  approveFeatureRequestPlan,
  featureRequest,
  featureRequestProgress,
  listFeatureRequests,
  listRecords,
  myAiUsage,
  sendFeatureRequestMessage,
  startFeatureRequest,
} from './api.js'
import App, { parseRoute } from './App.jsx'
import { AuthProvider } from './AuthContext.jsx'
import AuthGate from './AuthGate.jsx'

// DAN-82 — independent tester suite. Written from the acceptance criteria, not
// from the developer's tests:
//  - approving pushes /requests/:id onto history; reloading that URL reopens
//    the same session view; browser back returns to the prior view;
//  - /requests renders the list; clicking an entry navigates with pushState
//    (no reload); / keeps the records table;
//  - AuthGate still fronts everything; unknown paths render the records view.
// History/popstate are stubbed at the browser contract: back/forward is
// "the URL already moved, then popstate fires", so the tests replaceState and
// dispatch a PopStateEvent. A "reload" of a deep link is replaceState before
// render — exactly what Firebase Hosting's ** rewrite produces. api.js is
// fully mocked, as in every suite in this repo.

vi.mock('./api.js', () => ({
  listRecords: vi.fn(),
  createRecord: vi.fn(),
  updateRecord: vi.fn(),
  deleteRecord: vi.fn(),
  startFeatureRequest: vi.fn(),
  sendFeatureRequestMessage: vi.fn(),
  featureRequest: vi.fn(),
  listFeatureRequests: vi.fn(),
  myAiUsage: vi.fn(),
  approveFeatureRequestPlan: vi.fn(),
  featureRequestProgress: vi.fn(),
  featureRequestCost: vi.fn(),
}))

// Auth stub with a captured listener, so a test can flip the signed-in state
// mid-flight (the AuthGate deep-link test signs in AFTER the gate rendered).
const authStub = vi.hoisted(() => ({ user: null, listener: null }))

vi.mock('./auth.js', () => ({
  subscribeToAuth: vi.fn((listener) => {
    authStub.listener = listener
    listener(authStub.user)
    return () => {}
  }),
  signInWithGoogle: vi.fn(async () => {}),
  signOutUser: vi.fn(async () => {}),
  getIdToken: vi.fn(async () => (authStub.user ? 'tok' : null)),
}))

const RECORD = {
  id: 'r-1',
  name: 'Ledger row',
  status: 'active',
  amount: 7,
  notes: '',
  createdAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
}

// My own fixtures — a gathering session on a non-default model (so adoption
// visibly moves the locked picker) and a building one.
const GATHERING = {
  id: 'fr-alpha',
  status: 'gathering',
  model: 'gemini-3.6-flash',
  createdAt: '2026-08-25T12:00:00.000Z',
  messages: [
    { role: 'user', content: 'Let users export records as CSV' },
    { role: 'product-owner', content: 'Should the export include archived records?' },
  ],
  entranceCriteria: null,
  approvable: false,
  linearProjectUrl: null,
}

const BUILDING = {
  id: 'fr-beta',
  status: 'building',
  model: 'claude-opus-5',
  createdAt: '2026-08-24T09:30:00.000Z',
  messages: [{ role: 'user', content: 'Weekly digest email for admins' }],
  entranceCriteria: null,
  approvable: false,
  linearProjectUrl: null,
}

// Cold-load a URL: the reload/deep-link path. The URL is in place before App
// mounts, which is precisely what the hosting rewrite hands the bundle.
function renderAt(path) {
  window.history.replaceState(null, '', path)
  return render(<App />)
}

// Browser back/forward stub: the browser has already moved the URL when the
// popstate event reaches the page.
function popTo(path) {
  act(() => {
    window.history.replaceState(null, '', path)
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
}

beforeEach(() => {
  authStub.user = null
  authStub.listener = null
  vi.mocked(listRecords).mockReset().mockResolvedValue([RECORD])
  vi.mocked(startFeatureRequest).mockReset()
  vi.mocked(sendFeatureRequestMessage).mockReset()
  vi.mocked(featureRequest).mockReset()
  vi.mocked(listFeatureRequests)
    .mockReset()
    .mockResolvedValue([GATHERING, BUILDING])
  vi.mocked(myAiUsage)
    .mockReset()
    .mockResolvedValue({ requests: 2, totalTokens: 345 })
  vi.mocked(approveFeatureRequestPlan).mockReset()
  vi.mocked(featureRequestProgress).mockReset().mockResolvedValue([])
})

describe('DAN-82 tester · parseRoute matrix', () => {
  it('maps the three canonical paths, trailing slashes included', () => {
    expect(parseRoute('/')).toEqual({ view: 'records', requestId: null })
    expect(parseRoute('/requests')).toEqual({
      view: 'feature-request',
      requestId: null,
    })
    expect(parseRoute('/requests/')).toEqual({
      view: 'feature-request',
      requestId: null,
    })
    expect(parseRoute('/requests/abc123')).toEqual({
      view: 'feature-request',
      requestId: 'abc123',
    })
    expect(parseRoute('/requests/abc123/')).toEqual({
      view: 'feature-request',
      requestId: 'abc123',
    })
  })

  it('percent-decodes the id and keeps the raw segment on a malformed escape', () => {
    expect(parseRoute('/requests/fr%20one').requestId).toBe('fr one')
    expect(parseRoute('/requests/id%2Bplus').requestId).toBe('id+plus')
    // decodeURIComponent throws on these — the parse must not.
    expect(() => parseRoute('/requests/fr%')).not.toThrow()
    expect(parseRoute('/requests/fr%').requestId).toBe('fr%')
    expect(parseRoute('/requests/%E0%A4%A').requestId).toBe('%E0%A4%A')
  })

  it('sends every unknown path to the records view', () => {
    for (const path of [
      '/nope',
      '/requests/deep/extra',
      '/requestsuffix',
      '/Requests',
      '/requests//',
      '/blog',
      '',
    ]) {
      expect(parseRoute(path), path).toEqual({
        view: 'records',
        requestId: null,
      })
    }
  })
})

describe('DAN-82 tester · the URL picks the view at mount', () => {
  it('/ renders the records table, as today', async () => {
    renderAt('/')
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
    expect(screen.getByText('Ledger row')).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Request a feature' }),
    ).not.toBeInTheDocument()
  })

  it('/requests renders the request surface with the My-requests list', async () => {
    renderAt('/requests')
    expect(
      screen.getByRole('heading', { name: 'Request a feature' }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Message')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    const list = screen.getByRole('region', { name: 'My requests' })
    expect(
      await within(list).findByText(/Let users export records as CSV/),
    ).toBeInTheDocument()
    expect(
      within(list).getByText(/Weekly digest email for admins/),
    ).toBeInTheDocument()
  })

  it('an unknown path renders the records view, not a dead end', async () => {
    renderAt('/totally/unknown/path')
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
    expect(featureRequest).not.toHaveBeenCalled()
  })
})

describe('DAN-82 tester · deep links reload the session view', () => {
  it('reloading /requests/:id for a gathering session refetches it and reopens the chat', async () => {
    vi.mocked(featureRequest).mockResolvedValue(GATHERING)
    renderAt('/requests/fr-alpha')

    await waitFor(() =>
      expect(featureRequest).toHaveBeenCalledWith('fr-alpha'),
    )
    const transcript = await screen.findByRole('list', { name: 'Conversation' })
    expect(
      within(transcript).getByText(
        'Should the export include archived records?',
      ),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Message')).toBeEnabled()

    // Adoption locked the picker to the session's own (non-default) model.
    const radio = screen.getByRole('radio', { name: 'gemini-3.6-flash' })
    expect(radio).toBeChecked()
    expect(radio).toBeDisabled()

    // A session URL shows the session alone — no list, no records table.
    expect(
      screen.queryByRole('region', { name: 'My requests' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('reloading /requests/:id for a BUILDING session mounts the DAG polling exactly that id', async () => {
    vi.mocked(featureRequest).mockResolvedValue(BUILDING)
    renderAt('/requests/fr-beta')

    await screen.findByRole('region', { name: 'Build progress' })
    await waitFor(() =>
      expect(featureRequestProgress).toHaveBeenCalledWith('fr-beta'),
    )
    expect(
      vi
        .mocked(featureRequestProgress)
        .mock.calls.every(([id]) => id === 'fr-beta'),
    ).toBe(true)
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument()
  })

  it('shows a placeholder (no live composer) while the deep link is in flight', async () => {
    let resolveFetch
    vi.mocked(featureRequest).mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve
      }),
    )
    renderAt('/requests/fr-alpha')

    expect(screen.getByText('Loading session…')).toBeInTheDocument()
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument()

    await act(async () => {
      resolveFetch(GATHERING)
    })
    expect(
      await screen.findByRole('list', { name: 'Conversation' }),
    ).toBeInTheDocument()
  })

  it('browser back from a deep-linked session returns to the prior view', async () => {
    vi.mocked(featureRequest).mockResolvedValue(GATHERING)
    renderAt('/requests/fr-alpha')
    await screen.findByRole('list', { name: 'Conversation' })

    popTo('/requests')
    expect(
      screen.queryByRole('list', { name: 'Conversation' }),
    ).not.toBeInTheDocument()
    expect(screen.getByLabelText('Message')).toHaveValue('')
    expect(
      await screen.findByRole('region', { name: 'My requests' }),
    ).toBeInTheDocument()

    popTo('/')
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
  })
})

describe('DAN-82 tester · deep-link failure paths', () => {
  it('a network failure alerts and Back still works', async () => {
    vi.mocked(featureRequest).mockRejectedValue(new Error('Failed to fetch'))
    renderAt('/requests/fr-alpha')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Failed to fetch')
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Back to records' }))
    expect(window.location.pathname).toBe('/')
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
  })

  it('a foreign or unknown id (NOT_FOUND) does not crash — alert plus Back', async () => {
    const notFound = Object.assign(new Error('Feature request not found'), {
      extensions: { code: 'NOT_FOUND' },
    })
    vi.mocked(featureRequest).mockRejectedValue(notFound)
    renderAt('/requests/somebody-elses-id')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Feature request not found')
    // The frame survived: heading and the way out are still there.
    expect(
      screen.getByRole('heading', { name: 'Request a feature' }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back to records' }))
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
  })
})

describe('DAN-82 tester · in-app navigation is pushState, never a reload', () => {
  it('/ → /requests → back to / uses pushState and never refetches the records', async () => {
    renderAt('/')
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())

    const pushSpy = vi.spyOn(window.history, 'pushState')
    fireEvent.click(screen.getByRole('button', { name: 'Request a feature' }))

    expect(pushSpy).toHaveBeenCalledTimes(1)
    expect(pushSpy.mock.calls[0][2]).toBe('/requests')
    expect(window.location.pathname).toBe('/requests')
    expect(
      screen.getByRole('heading', { name: 'Request a feature' }),
    ).toBeInTheDocument()
    pushSpy.mockRestore()

    // Browser back: the records view returns from the still-mounted App state
    // — the single mount-time listRecords is the only fetch of the whole trip.
    popTo('/')
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByText('Ledger row')).toBeInTheDocument()
    expect(vi.mocked(listRecords)).toHaveBeenCalledTimes(1)
  })

  it('clicking a list entry pushes /requests/:id with no reload and no refetch', async () => {
    renderAt('/requests')
    const list = screen.getByRole('region', { name: 'My requests' })
    await within(list).findByText(/Let users export records as CSV/)

    const pushSpy = vi.spyOn(window.history, 'pushState')
    fireEvent.click(
      screen.getByRole('button', { name: /Let users export records as CSV/ }),
    )

    // One history push to the session URL...
    expect(pushSpy).toHaveBeenCalledTimes(1)
    expect(pushSpy.mock.calls[0][2]).toBe('/requests/fr-alpha')
    expect(window.location.pathname).toBe('/requests/fr-alpha')
    pushSpy.mockRestore()

    // ...the adopted transcript renders from the list's own object: no fetch
    // by id, and no reload — App never remounted (records were fetched exactly
    // once, at the original mount).
    const transcript = screen.getByRole('list', { name: 'Conversation' })
    expect(
      within(transcript).getByText(
        'Should the export include archived records?',
      ),
    ).toBeInTheDocument()
    expect(featureRequest).not.toHaveBeenCalled()
    expect(vi.mocked(listRecords)).toHaveBeenCalledTimes(1)
  })
})

describe('DAN-82 tester · approval pushes the session URL onto history', () => {
  it('approving pushes /requests/:id; browser back returns to the prior surface', async () => {
    const started = {
      id: 'fr-fresh',
      status: 'gathering',
      model: 'claude-opus-5',
      createdAt: '2026-08-27T08:00:00.000Z',
      messages: [],
      entranceCriteria: null,
      approvable: false,
      linearProjectUrl: null,
    }
    vi.mocked(startFeatureRequest).mockResolvedValue(started)
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue({
      ...started,
      messages: [
        { role: 'user', content: 'Nightly cleanup job' },
        { role: 'product-owner', content: 'Plan is ready.' },
      ],
      approvable: true,
    })
    vi.mocked(approveFeatureRequestPlan).mockResolvedValue({
      ...started,
      status: 'building',
      approvable: false,
    })

    renderAt('/requests')
    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: 'Nightly cleanup job' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Approve plan' }),
      ).toBeEnabled(),
    )
    expect(window.location.pathname).toBe('/requests')

    const pushSpy = vi.spyOn(window.history, 'pushState')
    fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }))
    await screen.findByRole('region', { name: 'Build progress' })

    // A real history entry for the session URL, no refetch of the session.
    expect(pushSpy).toHaveBeenCalledTimes(1)
    expect(pushSpy.mock.calls[0][2]).toBe('/requests/fr-fresh')
    expect(window.location.pathname).toBe('/requests/fr-fresh')
    expect(featureRequest).not.toHaveBeenCalled()
    pushSpy.mockRestore()

    // Browser back: the pre-approval /requests surface returns.
    popTo('/requests')
    expect(
      screen.queryByRole('region', { name: 'Build progress' }),
    ).not.toBeInTheDocument()
    expect(screen.getByLabelText('Message')).toHaveValue('')
    expect(
      await screen.findByRole('region', { name: 'My requests' }),
    ).toBeInTheDocument()
  })

  it('approving a session already at its own URL does not push a duplicate entry', async () => {
    vi.mocked(featureRequest).mockResolvedValue({
      ...GATHERING,
      approvable: true,
    })
    vi.mocked(approveFeatureRequestPlan).mockResolvedValue({
      ...GATHERING,
      status: 'building',
      approvable: false,
    })
    renderAt('/requests/fr-alpha')
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Approve plan' }),
      ).toBeEnabled(),
    )

    const pushSpy = vi.spyOn(window.history, 'pushState')
    fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }))
    await screen.findByRole('region', { name: 'Build progress' })

    // The URL was already /requests/fr-alpha — a second entry would turn the
    // Back button into a click eater.
    expect(pushSpy).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe('/requests/fr-alpha')
    pushSpy.mockRestore()
  })
})

describe('DAN-82 tester · AuthGate fronts every path', () => {
  it('a signed-out deep link shows sign-in and fetches nothing until sign-in completes', async () => {
    authStub.user = null
    vi.mocked(featureRequest).mockResolvedValue(GATHERING)
    window.history.replaceState(null, '', '/requests/fr-alpha')
    render(
      <AuthProvider>
        <AuthGate>
          <App />
        </AuthGate>
      </AuthProvider>,
    )

    expect(
      await screen.findByRole('button', { name: /sign in with google/i }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Request a feature' }),
    ).not.toBeInTheDocument()
    expect(featureRequest).not.toHaveBeenCalled()
    expect(listRecords).not.toHaveBeenCalled()

    // The user signs in (auth state flips); only now does the deep link load.
    act(() => {
      authStub.listener({ displayName: 'Dana', email: 'dana@example.com' })
    })
    const transcript = await screen.findByRole('list', { name: 'Conversation' })
    expect(
      within(transcript).getByText('Let users export records as CSV'),
    ).toBeInTheDocument()
    expect(featureRequest).toHaveBeenCalledWith('fr-alpha')
  })
})

describe('DAN-82 tester · rapid history traversal', () => {
  it('two popstates in quick succession settle on the final URL with a single mounted surface', async () => {
    vi.mocked(featureRequest).mockResolvedValue(GATHERING)
    renderAt('/requests/fr-alpha')
    await screen.findByRole('list', { name: 'Conversation' })

    // Back then immediately forward, faster than a render: both events land
    // in one batch. The app must settle on the final URL without mounting the
    // surface twice or fetching a foreign id.
    act(() => {
      window.history.replaceState(null, '', '/')
      window.dispatchEvent(new PopStateEvent('popstate'))
      window.history.replaceState(null, '', '/requests/fr-alpha')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    const transcripts = await screen.findAllByRole('list', {
      name: 'Conversation',
    })
    expect(transcripts).toHaveLength(1)
    expect(
      screen.getAllByRole('heading', { name: 'Request a feature' }),
    ).toHaveLength(1)
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(
      vi.mocked(featureRequest).mock.calls.every(([id]) => id === 'fr-alpha'),
    ).toBe(true)

    // And a rapid back-back to the records view still lands cleanly.
    act(() => {
      window.history.replaceState(null, '', '/requests')
      window.dispatchEvent(new PopStateEvent('popstate'))
      window.history.replaceState(null, '', '/')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
    expect(screen.getAllByRole('table')).toHaveLength(1)
  })
})
