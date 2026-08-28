import { createServer } from 'node:http'

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { AuthProvider } from './AuthContext.jsx'
import AuthGate from './AuthGate.jsx'
import { DEFAULT_LANGUAGE, LANGUAGE_STORAGE_KEY, changeLanguage, i18n } from './i18n.js'

// DAN-97 TESTER · independent verification of cross-device language persistence.
//
// The developer's suite mocks `api.js` wholesale, so it proves the hook reacts
// correctly to a promise — not that anything crosses a wire. This file removes
// that mock. `api.js` is the real module, `useLanguagePreference` is the real
// hook mounted by the real `AuthGate`, i18next is the real singleton, and the
// two calls go out over a REAL socket to a loopback server on an ephemeral port
// that implements DAN-96's contract (uid taken from the Authorization header,
// one row per uid, values restricted to en/es, null when unset).
//
// Only two things are stood in for, and both are things CI genuinely cannot
// have: `auth.js` (there is no Firebase credential here, so a token string is
// substituted for a real ID token) and the ORIGIN of the request — api.js posts
// to the relative path `/api/graphql`, which jsdom cannot resolve, so global
// fetch is wrapped to prefix the loopback base URL and otherwise passed through
// untouched. Method, headers, body and response are the real ones.
//
// "Cross-device" is exercised literally: one mount writes a preference over
// HTTP, is unmounted, the browser-local state (localStorage + the i18n
// instance's language) is wiped the way a second machine's would be, and a
// FRESH mount reads the preference back from the server and lands in Spanish
// with no user action. That sequence is the ticket's actual claim, and the
// developer's PR lists it as unverified end to end.
//
// The seam this cannot close is Firebase sign-in itself; see the verdict.

// --- the loopback server standing in for DAN-96's backend --------------------

// token -> uid. Two uids sharing a prefix so a sloppy match shows up as bleed.
const TOKENS = { 'token-ada': 'uid-ada', 'token-ada-2': 'uid-ada-2' }

let server
let baseUrl
let prefs // uid -> 'en' | 'es'
let requests // every request the client actually sent

function graphqlHandler(req, res) {
  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk
  })
  req.on('end', () => {
    const body = JSON.parse(raw)
    const auth = req.headers.authorization ?? ''
    requests.push({
      method: req.method,
      url: req.url,
      authorization: auth,
      contentType: req.headers['content-type'],
      query: body.query,
      variables: body.variables,
    })

    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }

    // DAN-22/DAN-96: the gate rejects before GraphQL ever runs.
    const uid = TOKENS[auth.replace(/^Bearer /, '')]
    if (!uid) return send(401, { error: { message: 'unauthenticated' } })

    if (/setLanguagePreference/.test(body.query)) {
      const language = body.variables?.language
      if (!['en', 'es'].includes(language)) {
        return send(200, {
          errors: [
            {
              message: 'language must be one of en, es',
              extensions: { code: 'BAD_USER_INPUT', field: 'language' },
            },
          ],
        })
      }
      prefs.set(uid, language)
      return send(200, { data: { setLanguagePreference: language } })
    }

    if (/languagePreference/.test(body.query)) {
      return send(200, { data: { languagePreference: prefs.get(uid) ?? null } })
    }

    // Anything else is a contract mismatch and must be loud, not silent.
    return send(200, { errors: [{ message: `unrecognized operation: ${body.query}` }] })
  })
}

// --- auth.js: the one thing CI cannot supply for real ------------------------

const authMock = vi.hoisted(() => ({ user: null, token: null }))

vi.mock('./auth.js', () => ({
  subscribeToAuth: vi.fn((listener) => {
    listener(authMock.user)
    return () => {}
  }),
  signInWithGoogle: vi.fn(async () => {}),
  signOutUser: vi.fn(async () => {}),
  getIdToken: vi.fn(async () => authMock.token),
}))

// --- harness -----------------------------------------------------------------

let realFetch

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/api/graphql' && req.method === 'POST') return graphqlHandler(req, res)
    res.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
  realFetch = globalThis.fetch
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

beforeEach(() => {
  prefs = new Map()
  requests = []
  authMock.user = null
  authMock.token = null
  // api.js posts to the relative '/api/graphql'; give it an origin and change
  // nothing else about the call.
  vi.stubGlobal('fetch', (url, init) =>
    realFetch(typeof url === 'string' && url.startsWith('/') ? baseUrl + url : url, init),
  )
})

// i18next is a singleton shared across the whole suite, so this file has to put
// it back. Order matters: unmount FIRST, then reset the language. Resetting it
// while the gate is still mounted would fire `languageChanged` at the live hook
// and send a real, fire-and-forget mutation that lands during the NEXT test and
// shows up there as a phantom write. (This is a property of the test harness,
// not of the hook — the hook is doing exactly what it should with a switch it
// was handed.)
afterEach(async () => {
  cleanup()
  await act(async () => {
    await changeLanguage(DEFAULT_LANGUAGE)
  })
  window.localStorage.clear()
  // Let anything the test itself put in flight land before the counters reset.
  await new Promise((resolve) => setTimeout(resolve, 30))
  vi.unstubAllGlobals()
})

function signIn(name) {
  authMock.user = { uid: TOKENS[name], displayName: 'Ada Lovelace' }
  authMock.token = name
}

function renderApp() {
  return render(
    <AuthProvider>
      <AuthGate>
        <div>records ui</div>
      </AuthGate>
    </AuthProvider>,
  )
}

const selector = () => screen.getByRole('combobox', { name: /language|idioma/i })

// What a second machine looks like: nothing of this browser's state survives.
async function asAnotherDevice() {
  await act(async () => {
    await changeLanguage(DEFAULT_LANGUAGE)
  })
  // After the reset, not before: DAN-95's listener writes localStorage on every
  // switch, so clearing first would leave 'en' behind.
  window.localStorage.clear()
  requests = []
}

const languageReads = () => requests.filter((r) => !/setLanguagePreference/.test(r.query))
const languageWrites = () => requests.filter((r) => /setLanguagePreference/.test(r.query))

// --- the ticket's headline claim, in one continuous run ----------------------

describe('DAN-97 · a preference set on one device follows the user to the next', () => {
  it('device A switches to Spanish; device B loads in Spanish with no user action', async () => {
    const user = userEvent.setup()
    signIn('token-ada')

    // --- device A -------------------------------------------------------
    const deviceA = renderApp()
    await waitFor(() => expect(languageReads()).toHaveLength(1))
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()

    await user.selectOptions(selector(), 'es')

    // The write actually reached the server, over the socket.
    await waitFor(() => expect(prefs.get('uid-ada')).toBe('es'))
    deviceA.unmount()

    // --- device B: a machine that has never seen this user --------------
    await asAnotherDevice()
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBeNull()
    expect(i18n.resolvedLanguage).toBe('en')

    renderApp()

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Cerrar sesión' })).toBeInTheDocument(),
    )
    expect(selector()).toHaveValue('es')
    // Nobody touched the switcher on device B.
    expect(languageWrites()).toHaveLength(0)
  })

  it('the preference is the signed-in user\'s, not the browser\'s', async () => {
    const user = userEvent.setup()
    signIn('token-ada')

    const first = renderApp()
    await waitFor(() => expect(languageReads()).toHaveLength(1))
    await user.selectOptions(selector(), 'es')
    await waitFor(() => expect(prefs.get('uid-ada')).toBe('es'))
    first.unmount()

    // A different account on a clean machine must not inherit it.
    await asAnotherDevice()
    signIn('token-ada-2')
    renderApp()

    await waitFor(() => expect(languageReads()).toHaveLength(1))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument(),
    )
    expect(i18n.resolvedLanguage).toBe('en')
    expect(prefs.get('uid-ada-2')).toBeUndefined()
  })
})

// --- criterion 1: a stored preference decides a fresh load -------------------

describe('DAN-97 · criterion 1 · stored preference decides a fresh load', () => {
  it('lands in Spanish over the wire, overriding a local value of "en"', async () => {
    prefs.set('uid-ada', 'es')
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, 'en')
    signIn('token-ada')

    renderApp()

    await waitFor(() => expect(i18n.resolvedLanguage).toBe('es'))
    expect(screen.getByRole('button', { name: 'Cerrar sesión' })).toBeInTheDocument()
    // DAN-95's own listener picks the server value up as the new local default.
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('es')
  })

  it('sends the read as an authenticated POST with no uid on the wire', async () => {
    prefs.set('uid-ada', 'es')
    signIn('token-ada')

    renderApp()
    await waitFor(() => expect(languageReads()).toHaveLength(1))

    const read = languageReads()[0]
    expect(read.method).toBe('POST')
    expect(read.url).toBe('/api/graphql')
    expect(read.authorization).toBe('Bearer token-ada')
    expect(read.query).toMatch(/languagePreference/)
    // A client-supplied uid would be a client-supplied identity.
    expect(read.query).not.toMatch(/uid/i)
    expect(read.variables ?? {}).toEqual({})
  })

  it('applying the stored value does not echo it back as a write', async () => {
    prefs.set('uid-ada', 'es')
    signIn('token-ada')

    renderApp()

    await waitFor(() => expect(i18n.resolvedLanguage).toBe('es'))
    // Give an echo a chance to appear before declaring it absent.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(languageWrites()).toHaveLength(0)
  })
})

// --- criterion 2: exactly once per change, soft failure ----------------------

describe('DAN-97 · criterion 2 · one write per change, failure stays silent', () => {
  it('writes once per switch and lands the value the server keeps', async () => {
    const user = userEvent.setup()
    signIn('token-ada')
    renderApp()
    await waitFor(() => expect(languageReads()).toHaveLength(1))

    await user.selectOptions(selector(), 'es')
    await waitFor(() => expect(languageWrites()).toHaveLength(1))
    expect(languageWrites()[0].variables).toEqual({ language: 'es' })
    expect(languageWrites()[0].query).toMatch(/\$language:\s*String!/)

    await user.selectOptions(selector(), 'en')
    await waitFor(() => expect(languageWrites()).toHaveLength(2))
    expect(languageWrites()[1].variables).toEqual({ language: 'en' })
    expect(prefs.get('uid-ada')).toBe('en')

    // No extra traffic settles in afterwards.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(languageWrites()).toHaveLength(2)
    expect(languageReads()).toHaveLength(1)
  })

  it('a 500 from the write leaves the UI switched, with no alert', async () => {
    const user = userEvent.setup()
    signIn('token-ada')
    renderApp()
    await waitFor(() => expect(languageReads()).toHaveLength(1))

    // Break only the write, and only at the transport level.
    vi.stubGlobal('fetch', async (url, init) => {
      const body = JSON.parse(init.body)
      if (/setLanguagePreference/.test(body.query)) {
        requests.push({ query: body.query, variables: body.variables })
        return new Response('gateway blew up', { status: 500 })
      }
      return realFetch(baseUrl + url, init)
    })

    await user.selectOptions(selector(), 'es')

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Cerrar sesión' })).toBeInTheDocument(),
    )
    expect(languageWrites()).toHaveLength(1)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    // The local fallback still carries the choice into the next load here.
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('es')
    // And the app is still usable: records children stayed mounted.
    expect(screen.getByText('records ui')).toBeInTheDocument()
  })

  it('a BAD_USER_INPUT rejection is also swallowed, not surfaced', async () => {
    const user = userEvent.setup()
    signIn('token-ada')
    renderApp()
    await waitFor(() => expect(languageReads()).toHaveLength(1))

    // Real execution-level error shape, produced by the loopback server itself.
    vi.stubGlobal('fetch', (url, init) => {
      const body = JSON.parse(init.body)
      if (/setLanguagePreference/.test(body.query)) {
        init = { ...init, body: JSON.stringify({ ...body, variables: { language: 'fr' } }) }
      }
      return realFetch(baseUrl + url, init)
    })

    await user.selectOptions(selector(), 'es')

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Cerrar sesión' })).toBeInTheDocument(),
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(i18n.resolvedLanguage).toBe('es')
  })
})

// --- criterion 3: a null preference is DAN-95, unchanged ---------------------

describe('DAN-97 · criterion 3 · null preference changes nothing', () => {
  it('honours the local pick when the server has no row', async () => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, 'es')
    await act(async () => {
      await changeLanguage('es')
    })
    signIn('token-ada')

    renderApp()

    await waitFor(() => expect(languageReads()).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(i18n.resolvedLanguage).toBe('es')
    expect(screen.getByRole('button', { name: 'Cerrar sesión' })).toBeInTheDocument()
    // Nothing was pushed either: the user did not change anything.
    expect(languageWrites()).toHaveLength(0)
  })

  it('boots English with neither a server row nor a local value', async () => {
    signIn('token-ada')

    renderApp()

    await waitFor(() => expect(languageReads()).toHaveLength(1))
    expect(i18n.resolvedLanguage).toBe('en')
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
  })

  it('signed out, the switcher still works and nothing is sent', async () => {
    const user = userEvent.setup()
    renderApp()

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sign in with Google' })).toBeInTheDocument(),
    )
    await user.selectOptions(selector(), 'es')

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Iniciar sesión con Google' }),
      ).toBeInTheDocument(),
    )
    expect(requests).toHaveLength(0)
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('es')
  })
})
