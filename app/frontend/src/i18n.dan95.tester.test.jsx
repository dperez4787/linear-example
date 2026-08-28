import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from './App.jsx'
import { AuthProvider } from './AuthContext.jsx'
import AuthGate from './AuthGate.jsx'
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  SUPPORTED_LANGUAGES,
  i18n,
  initialLanguage,
  resolveInitialLanguage,
} from './i18n.js'
import LanguageSwitcher from './LanguageSwitcher.jsx'
import en from './locales/en.json'
import es from './locales/es.json'

// DAN-95 · INDEPENDENT TESTER SUITE.
//
// Written against the ticket's acceptance criteria as stated on the Linear
// issue, not against the developer's implementation notes:
//
//   AC1  Install and configure a React i18n library (e.g. react-i18next).
//   AC2  Externalize all fixed UI text (navigation, labels, buttons, dialogs,
//        empty states) into English and Spanish dictionary files.
//   AC3  A language selector component that updates the UI IMMEDIATELY when
//        toggled.
//   AC4  Store the current session language preference in localStorage.
//
// Deliberately different in approach from the developer's own tests: these
// drive the composed application shell (AuthProvider → AuthGate → App) through
// real user events rather than unit-testing the i18n module, and they check the
// clean-checkout story (dependencies declared, lockfile pinned) that a passing
// local run cannot prove on its own.

const SRC = dirname(fileURLToPath(import.meta.url))
const FRONTEND = resolve(SRC, '..')

// --- Test doubles ----------------------------------------------------------
// auth.js: a signed-in user pushed synchronously, so the header chrome (where
// the switcher lives) and the records view both mount with no Firebase.
vi.mock('./auth.js', () => ({
  subscribeToAuth: vi.fn((listener) => {
    listener({ displayName: 'Test User', email: 'test@example.com' })
    return () => {}
  }),
  signInWithGoogle: vi.fn(async () => {}),
  signOutUser: vi.fn(async () => {}),
  getIdToken: vi.fn(async () => 'token'),
}))

// api.js: an empty record list, so the records view lands on its EMPTY STATE —
// one of the four text categories AC2 names explicitly.
vi.mock('./api.js', () => ({
  listRecords: vi.fn(async () => []),
  createRecord: vi.fn(async (r) => ({ ...r, id: 'r1', updatedAt: new Date().toISOString() })),
  updateRecord: vi.fn(async (id, patch) => ({ id, ...patch })),
  deleteRecord: vi.fn(async () => {}),
}))

function renderShell() {
  return render(
    <AuthProvider>
      <AuthGate>
        <App />
      </AuthGate>
    </AuthProvider>,
  )
}

// The switcher is the only <select> in the header chrome; find it by its label.
function switcher() {
  return screen.getByLabelText(en.language.label)
}

beforeEach(async () => {
  window.localStorage.clear()
  // Every test starts from a known language regardless of order — i18next is a
  // process-wide singleton within a Vitest file.
  await i18n.changeLanguage(DEFAULT_LANGUAGE)
  window.localStorage.clear()
})

afterEach(async () => {
  await i18n.changeLanguage(DEFAULT_LANGUAGE)
  window.localStorage.clear()
})

// ---------------------------------------------------------------------------
// AC1 — a React i18n library is installed and configured
// ---------------------------------------------------------------------------
describe('DAN-95 AC1 · react-i18next is installed and configured', () => {
  const pkg = JSON.parse(readFileSync(resolve(FRONTEND, 'package.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(resolve(FRONTEND, 'package-lock.json'), 'utf8'))

  // A dependency the suite needs but package.json does not declare is a suite
  // that passes here and fails on a clean checkout.
  it('declares i18next and react-i18next as runtime dependencies', () => {
    expect(pkg.dependencies).toHaveProperty('i18next')
    expect(pkg.dependencies).toHaveProperty('react-i18next')
    // Runtime UI text is shipped code, not a build-time tool.
    expect(pkg.devDependencies ?? {}).not.toHaveProperty('i18next')
    expect(pkg.devDependencies ?? {}).not.toHaveProperty('react-i18next')
  })

  it('pins both packages in package-lock.json so npm ci resolves them', () => {
    expect(lock.packages).toHaveProperty('node_modules/i18next')
    expect(lock.packages).toHaveProperty('node_modules/react-i18next')
  })

  it('initializes exactly one i18next instance bound to React', () => {
    expect(i18n.isInitialized).toBe(true)
    // initReactI18next registers itself as a third-party module on the instance.
    expect(i18n.options.react).toBeDefined()
  })

  it('carries English and Spanish resource bundles with English as the fallback', () => {
    expect(SUPPORTED_LANGUAGES).toEqual(expect.arrayContaining(['en', 'es']))
    expect(i18n.getResourceBundle('en', 'translation')).toBeTruthy()
    expect(i18n.getResourceBundle('es', 'translation')).toBeTruthy()
    expect([].concat(i18n.options.fallbackLng)).toContain('en')
  })

  it('resolves keys rather than echoing them back', async () => {
    expect(i18n.t('records.title')).toBe('Records')
    await i18n.changeLanguage('es')
    expect(i18n.t('records.title')).toBe('Registros')
  })
})

// ---------------------------------------------------------------------------
// AC2 — fixed UI text is externalized into en/es dictionaries
// ---------------------------------------------------------------------------
describe('DAN-95 AC2 · fixed UI text lives in the dictionaries', () => {
  // An independent re-derivation of the dotted key set (the developer's suite
  // has its own; agreeing twice from two implementations is the point).
  function keysOf(node, prefix = '') {
    const out = []
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...keysOf(v, `${prefix}${k}.`))
      else out.push(`${prefix}${k}`)
    }
    return out.sort()
  }

  it('English and Spanish declare an identical key set', () => {
    const enKeys = keysOf(en)
    const esKeys = keysOf(es)
    expect(esKeys.filter((k) => !enKeys.includes(k))).toEqual([]) // extra in es
    expect(enKeys.filter((k) => !esKeys.includes(k))).toEqual([]) // missing from es
  })

  // A Spanish value byte-identical to English is usually an untranslated stub.
  // A handful of words are legitimately the same in both languages.
  it('actually translates the Spanish dictionary', () => {
    const SAME_IN_BOTH = new Set(['featureRequest.usage.tokens'])
    const untranslated = keysOf(en).filter((key) => {
      const read = (o) => key.split('.').reduce((acc, k) => acc?.[k], o)
      return read(en) === read(es) && !SAME_IN_BOTH.has(key)
    })
    expect(untranslated).toEqual([])
  })

  // The scan that catches the regression this ticket exists to prevent: a new
  // component shipping a hardcoded English string.
  const COMPONENTS = readdirSync(SRC).filter(
    (f) => f.endsWith('.jsx') && !f.includes('.test.') && f !== 'main.jsx',
  )

  it('leaves no hardcoded user-visible aria-label, placeholder or title in any component', () => {
    const offenders = []
    for (const file of COMPONENTS) {
      const source = readFileSync(resolve(SRC, file), 'utf8')
      for (const m of source.matchAll(/(aria-label|placeholder|title)="([^"]+)"/g)) {
        offenders.push(`${file}: ${m[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('leaves no hardcoded English sentence as JSX text in any component', () => {
    // Strings that are NOT UI copy and correctly stay literal.
    const ALLOWED = new Set([
      'linear-example', // the product name, never translated
      'user', // server-side role vocabulary, rendered verbatim for delivered
      // messages too (FeatureRequestView renders {message.role});
      // translating only the optimistic copy would label one
      // speaker two ways in the same transcript.
    ])
    const offenders = []
    for (const file of COMPONENTS) {
      // Strip comments first: prose about JSX (`a real <button> inside the
      // <th>`) is not shipped text, and an arrow function's `=>` followed by a
      // `<` comparison would otherwise read as a text node.
      const source = readFileSync(resolve(SRC, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      // `(?<![=!<>-])>` skips `=>`, `>=`, `<=`, `->`; the trailing `<\/?[A-Za-z]`
      // requires a real opening or closing tag, not a `<` comparison operator.
      for (const m of source.matchAll(
        /(?<![=!<>-])>\s*([A-Za-z][A-Za-z0-9 '’,.…—-]{2,})\s*<\/?[A-Za-z]/g,
      )) {
        const text = m[1].trim()
        if (!ALLOWED.has(text)) offenders.push(`${file}: "${text}"`)
      }
    }
    expect(offenders).toEqual([])
  })

  // The categories AC2 names, proven by rendering rather than by reading JSON.
  it('renders navigation, labels, buttons and empty states from the dictionary', async () => {
    renderShell()
    await screen.findByText(en.records.table.empty) // empty state

    // navigation / header chrome
    expect(screen.getByText(en.nav.blog)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: en.nav.signOut })).toBeInTheDocument()
    // headings + buttons
    expect(screen.getByRole('heading', { name: en.records.title })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: en.records.requestFeature })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: en.records.form.submit })).toBeInTheDocument()
    // form + table labels
    expect(screen.getByLabelText(en.records.form.nameLabel)).toBeInTheDocument()
    expect(screen.getByLabelText(en.records.table.filterByName)).toBeInTheDocument()
  })

  it('renders that same surface in Spanish when the instance is Spanish', async () => {
    await i18n.changeLanguage('es')
    renderShell()
    await screen.findByText(es.records.table.empty)

    expect(screen.getByText(es.nav.blog)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: es.nav.signOut })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: es.records.title })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: es.records.requestFeature })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: es.records.form.submit })).toBeInTheDocument()
    expect(screen.getByLabelText(es.records.form.nameLabel)).toBeInTheDocument()
    expect(screen.getByLabelText(es.records.table.filterByName)).toBeInTheDocument()

    // and no English left behind on the same screen
    expect(screen.queryByText(en.records.table.empty)).toBeNull()
    expect(screen.queryByRole('button', { name: en.nav.signOut })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// AC3 — the selector updates the UI immediately when toggled
// ---------------------------------------------------------------------------
describe('DAN-95 AC3 · the language selector repaints the UI in place', () => {
  it('is present in the app chrome as a labelled control offering both languages', async () => {
    renderShell()
    await screen.findByText(en.records.table.empty)
    const select = switcher()
    expect(select.tagName).toBe('SELECT')
    expect([...select.options].map((o) => o.value).sort()).toEqual(['en', 'es'])
    // Each option names its language in that language.
    expect([...select.options].map((o) => o.textContent)).toEqual(
      expect.arrayContaining(['English', 'Español']),
    )
    expect(select.value).toBe('en')
  })

  it('switches every visible string on toggle, with no reload', async () => {
    const reload = vi.fn()
    const original = Object.getOwnPropertyDescriptor(window, 'location')
    // Detect a full-page reload as the (unacceptable) update mechanism.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload, pathname: '/' },
    })

    try {
      const user = userEvent.setup()
      renderShell()
      await screen.findByText(en.records.table.empty)

      await user.selectOptions(switcher(), 'es')

      await waitFor(() => {
        expect(screen.getByText(es.records.table.empty)).toBeInTheDocument()
      })
      expect(screen.getByRole('heading', { name: es.records.title })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: es.nav.signOut })).toBeInTheDocument()
      expect(screen.getByLabelText(es.records.form.nameLabel)).toBeInTheDocument()
      expect(screen.queryByText(en.records.table.empty)).toBeNull()
      expect(reload).not.toHaveBeenCalled()
    } finally {
      if (original) Object.defineProperty(window, 'location', original)
    }
  })

  it('updates in place — the DOM is not remounted and component state survives', async () => {
    const user = userEvent.setup()
    renderShell()
    await screen.findByText(en.records.table.empty)

    // Local state that only exists because the user typed it.
    const nameFilter = screen.getByLabelText(en.records.table.filterByName)
    await user.type(nameFilter, 'widget')
    expect(nameFilter).toHaveValue('widget')

    const headingBefore = screen.getByRole('heading', { name: en.records.title })

    await user.selectOptions(switcher(), 'es')
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: es.records.title })).toBeInTheDocument()
    })

    // Same DOM node, new text: a re-render, not a remount.
    expect(screen.getByRole('heading', { name: es.records.title })).toBe(headingBefore)
    // Uncontrolled-by-i18n component state is intact.
    expect(screen.getByLabelText(es.records.table.filterByName)).toHaveValue('widget')
  })

  it('toggles back to English just as immediately', async () => {
    const user = userEvent.setup()
    renderShell()
    await screen.findByText(en.records.table.empty)

    await user.selectOptions(switcher(), 'es')
    await waitFor(() => expect(screen.getByText(es.records.table.empty)).toBeInTheDocument())

    await user.selectOptions(screen.getByLabelText(es.language.label), 'en')
    await waitFor(() => expect(screen.getByText(en.records.table.empty)).toBeInTheDocument())
    expect(switcher().value).toBe('en')
  })

  it('keeps <html lang> in step with the selected language', async () => {
    const user = userEvent.setup()
    renderShell()
    await screen.findByText(en.records.table.empty)
    expect(document.documentElement.lang).toBe('en')

    await user.selectOptions(switcher(), 'es')
    await waitFor(() => expect(document.documentElement.lang).toBe('es'))
  })

  it('reaches the switcher from the signed-out screen too', async () => {
    // The gate renders its own header when there is no user; the control has to
    // be there as well, or a user cannot read the sign-in prompt in Spanish.
    const { subscribeToAuth } = await import('./auth.js')
    subscribeToAuth.mockImplementationOnce((listener) => {
      listener(null)
      return () => {}
    })
    const user = userEvent.setup()
    render(
      <AuthProvider>
        <AuthGate>
          <div>records ui</div>
        </AuthGate>
      </AuthProvider>,
    )
    await screen.findByText(en.auth.signInPrompt)

    await user.selectOptions(switcher(), 'es')
    await waitFor(() => {
      expect(screen.getByText(es.auth.signInPrompt)).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: es.auth.signInWithGoogle })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// AC4 — the preference is stored in localStorage
// ---------------------------------------------------------------------------
describe('DAN-95 AC4 · the session language preference persists in localStorage', () => {
  it('writes the chosen language to localStorage when the user toggles', async () => {
    const user = userEvent.setup()
    renderShell()
    await screen.findByText(en.records.table.empty)
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBeNull()

    await user.selectOptions(switcher(), 'es')
    await waitFor(() => {
      expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('es')
    })

    await user.selectOptions(screen.getByLabelText(es.language.label), 'en')
    await waitFor(() => {
      expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('en')
    })
  })

  // The boot decision itself. NOTE: this file has already imported i18n.js, so
  // the singleton is initialized and re-importing it (even after
  // vi.resetModules()) cannot re-run init — vi.resetModules() re-evaluates the
  // app's own modules but not the i18next package they share. The end-to-end
  // "second visit comes back up in Spanish" proof therefore lives in
  // src/i18n.boot.dan95.tester.test.jsx, which seeds localStorage before the
  // first import. What is provable here is the wiring and the read.
  it('boots the instance with whatever the stored-preference read returned', () => {
    // Nothing was stored when this file imported i18n.js.
    expect(initialLanguage).toBe('en')
    expect(i18n.options.lng).toBe(initialLanguage)
  })

  it('reads a stored supported language back as the boot decision', () => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, 'es')
    expect(resolveInitialLanguage()).toBe('es')
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, 'en')
    expect(resolveInitialLanguage()).toBe('en')
  })

  it('falls back to English when nothing is stored', () => {
    window.localStorage.clear()
    expect(resolveInitialLanguage()).toBe(DEFAULT_LANGUAGE)
  })

  it('ignores an unsupported or corrupted stored value instead of trusting it', () => {
    for (const junk of ['fr', '', 'null', '{"lang":"es"}', 'EN', 'es-MX']) {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, junk)
      expect(resolveInitialLanguage()).toBe(DEFAULT_LANGUAGE)
    }
  })

  // Safari private mode throws on both getItem and setItem. A language
  // preference is never worth a white screen.
  it('still boots and still switches when localStorage throws', async () => {
    const proto = Object.getPrototypeOf(window.localStorage)
    const getSpy = vi.spyOn(proto, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    const setSpy = vi.spyOn(proto, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    try {
      // The boot read degrades to "no stored preference" rather than throwing.
      expect(() => resolveInitialLanguage()).not.toThrow()
      expect(resolveInitialLanguage()).toBe('en')

      // And the running session still switches, unpersisted.
      const user = userEvent.setup()
      renderShell()
      await screen.findByText(en.records.table.empty)
      await user.selectOptions(switcher(), 'es')
      await waitFor(() => {
        expect(screen.getByText(es.records.table.empty)).toBeInTheDocument()
      })
    } finally {
      getSpy.mockRestore()
      setSpy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// CLAUDE.md conventions that are mechanically checkable
// ---------------------------------------------------------------------------
describe('DAN-95 · repo conventions', () => {
  it('keeps fetch() out of components — the switcher and i18n add no network calls', () => {
    const offenders = readdirSync(SRC)
      .filter((f) => (f.endsWith('.jsx') || f === 'i18n.js') && !f.includes('.test.'))
      .filter((f) => /\bfetch\s*\(/.test(readFileSync(resolve(SRC, f), 'utf8')))
    expect(offenders).toEqual([])
  })

  it('commits no dictionary that looks like a credential', () => {
    const blob = JSON.stringify(en) + JSON.stringify(es)
    expect(blob).not.toMatch(/mongodb\+srv|AIza[0-9A-Za-z_-]{20,}|sk-[0-9A-Za-z]{20,}/)
  })
})
