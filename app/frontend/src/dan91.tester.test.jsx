import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  approveFeatureRequestPlan,
  featureRequestActivity,
  featureRequestCost,
  featureRequestProgress,
  listFeatureRequests,
  myAiUsage,
  sendFeatureRequestMessage,
  startFeatureRequest,
} from './api.js'
import FeatureRequestView from './FeatureRequestView.jsx'
import MyRequests from './MyRequests.jsx'
import WatchBuild from './WatchBuild.jsx'

// DAN-91 tester suite — independent verification written from the ticket's
// acceptance criteria, not from the developer's tests.
//
// The criteria are: the my-requests row shows `title` when present and falls
// back to DAN-74's truncated first-message preview when it is null; the build
// header shows the title beside the "View in Linear" link and hides it when
// null; the slug is printed exactly as the backend produced it (snake_case, no
// re-casing, no truncation in JS); a long slug degrades gracefully instead of
// breaking the layout; and api.js selects the field.
//
// Two things this suite does that eyeballing cannot:
//
//   1. "layout unchanged either way" is proven STRUCTURALLY — every rendered
//      row is reduced to a tag+class skeleton with all text stripped, and the
//      titled, null-title, blank-title and 120-char-slug skeletons are compared
//      as strings. A row that gained a wrapper, lost a span, or changed a class
//      in one branch fails here even though it would still "look fine".
//   2. "truncates gracefully" is checked against the real stylesheet: the DOM
//      must carry the full slug (no JS ellipsis), and styles.css must resolve
//      the one-line-clip declarations for the elements that hold it. A DOM-only
//      assertion would pass on a slug that overflows its row in a browser.
//
// api.js is mocked module-wide for the component work (the DAN-53..84 idiom);
// the api-layer criterion uses vi.importActual to exercise the real module over
// a stubbed fetch, which is why it lives in the same file without conflict.
vi.mock('./api.js', () => ({
  startFeatureRequest: vi.fn(),
  sendFeatureRequestMessage: vi.fn(),
  myAiUsage: vi.fn(),
  approveFeatureRequestPlan: vi.fn(),
  featureRequest: vi.fn(),
  listFeatureRequests: vi.fn(),
  featureRequestProgress: vi.fn(),
  featureRequestCost: vi.fn(),
  featureRequestActivity: vi.fn(),
}))

vi.mock('./auth.js', () => ({
  getIdToken: vi.fn(async () => null),
  signOutUser: vi.fn(async () => {}),
}))

/* -- fixtures ---------------------------------------------------------------- */

const SLUG = 'change_buttons_to_green'

// 120 characters, no spaces — one unbroken snake_case word, which is the shape
// that actually threatens a flex row (a long *sentence* would wrap on its own).
const LONG_SLUG =
  'add_a_nightly_usage_report_emailed_to_every_workspace_admin_with_a_per_team_cost_breakdown_and_a_csv_attachment_pls_okay'

const FIRST_MESSAGE =
  'Please add a nightly usage report that gets emailed to every workspace admin with a per-team cost breakdown attached'

// What DAN-74's previewOf() must still produce for an untitled row: 79 chars of
// the first user message plus an ellipsis. Computed here from the ticket's rule
// rather than imported, so a change to the component cannot silently redefine
// the expectation this suite is checking.
const PREVIEW = `${FIRST_MESSAGE.slice(0, 79)}…`

const LINEAR_URL = 'https://linear.app/tester-org/project/nightly-report-4f2a9c'

// Both fixtures share status and date so their row skeletons are comparable —
// the status class is status-derived, and only the label branch is under test.
function request(overrides = {}) {
  return {
    id: 'fr-tester',
    status: 'building',
    model: 'claude-opus-5',
    createdAt: '2026-08-27T10:00:00.000Z',
    title: null,
    messages: [
      { role: 'user', content: FIRST_MESSAGE },
      { role: 'product-owner', content: 'Filed as tickets.' },
    ],
    entranceCriteria: null,
    approvable: false,
    linearProjectUrl: LINEAR_URL,
    ...overrides,
  }
}

const ticket = {
  issueId: 'iss-t1',
  identifier: 'DAN-99',
  title: 'Tester ticket',
  state: 'IN_PROGRESS',
  issueUrl: 'https://linear.app/tester-org/issue/DAN-99',
  prUrl: null,
  blockedBy: [],
}

const ledger = { calls: 7, tokensIn: 4900, tokensOut: 2100, costUsd: 0.1234 }

/* -- structural skeleton ------------------------------------------------------ */

// An element reduced to nothing but its shape: tag name, class list (sorted, so
// class order is not mistaken for a structural change) and children, with every
// text node dropped. Two renders that produce the same string are the same
// layout regardless of what words are in them.
function skeleton(el) {
  const classes = [...el.classList].sort().join('.')
  const kids = [...el.children].map(skeleton).join(',')
  return `${el.tagName.toLowerCase()}${classes ? `.${classes}` : ''}${
    kids ? `(${kids})` : ''
  }`
}

async function renderRow(overrides) {
  vi.mocked(listFeatureRequests).mockResolvedValue([request(overrides)])
  const { unmount } = render(<MyRequests onOpen={() => {}} />)
  const region = screen.getByRole('region', { name: 'My requests' })
  const row = await within(region).findByRole('button')
  const result = {
    skeleton: skeleton(row),
    label: row.querySelector('.my-requests__preview'),
    text: row.querySelector('.my-requests__preview')?.textContent,
    accessibleText: row.textContent,
  }
  unmount()
  return result
}

beforeEach(() => {
  vi.mocked(listFeatureRequests).mockReset()
  vi.mocked(featureRequestProgress).mockReset()
  vi.mocked(featureRequestCost).mockReset()
  // WatchBuild also reads the activity feed (DAN-84). Left resolving undefined
  // on purpose: WatchBuild treats a falsy activity read as "nothing new", so
  // the feed stays empty and cannot colour any assertion in this suite.
  vi.mocked(featureRequestActivity).mockReset()
  vi.mocked(featureRequestProgress).mockResolvedValue([ticket])
  vi.mocked(featureRequestCost).mockResolvedValue(ledger)
  vi.mocked(myAiUsage).mockResolvedValue({ requests: 1, totalTokens: 400 })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/* -- Criterion 1: the my-requests row label ----------------------------------- */

describe('DAN-91 tester · my-requests row label', () => {
  it('shows the slug verbatim — underscores intact, no case change, no space substitution', async () => {
    const row = await renderRow({ title: SLUG })

    // Exact text, byte for byte. Not "contains", not "matches loosely".
    expect(row.text).toBe('change_buttons_to_green')
    expect(row.text).toBe(SLUG)
    // The three rewrites a well-meaning formatter would apply, each ruled out.
    expect(row.text).not.toBe('Change buttons to green')
    expect(row.text).not.toBe('change buttons to green')
    expect(row.text).not.toBe('Change_Buttons_To_Green')
    expect(row.text).not.toContain(' ')
    expect((row.text.match(/_/g) ?? []).length).toBe(3)
    // And the first message is not also shown — the slug replaces it.
    expect(row.accessibleText).not.toContain('nightly usage report')
  })

  it('falls back to the truncated first-message preview when title is null', async () => {
    const row = await renderRow({ title: null })

    expect(row.text).toBe(PREVIEW)
    expect(row.text.endsWith('…')).toBe(true)
    expect(row.text).toHaveLength(80)
  })

  it('falls back when title is an empty string or whitespace-only', async () => {
    for (const blank of ['', '   ', '\t', '\n  \n']) {
      const row = await renderRow({ title: blank })
      expect(row.text).toBe(PREVIEW)
    }
  })

  it('falls back when the request predates the field entirely (no title key)', async () => {
    const { title: _dropped, ...legacy } = request()
    vi.mocked(listFeatureRequests).mockResolvedValue([legacy])
    render(<MyRequests onOpen={() => {}} />)

    const region = screen.getByRole('region', { name: 'My requests' })
    const row = await within(region).findByRole('button')
    expect(row.querySelector('.my-requests__preview').textContent).toBe(PREVIEW)
  })

  it('keeps an identical row skeleton across every label branch (layout unchanged)', async () => {
    const titled = await renderRow({ title: SLUG })
    const untitled = await renderRow({ title: null })
    const blank = await renderRow({ title: '   ' })
    const long = await renderRow({ title: LONG_SLUG })

    // The reference shape, spelled out — so a regression that changes *all*
    // four branches the same way still fails this test.
    expect(titled.skeleton).toBe(
      'button.my-requests__row(' +
        'span.my-requests__preview,' +
        'span.my-requests__status.my-requests__status--building,' +
        'span.my-requests__date)',
    )
    expect(untitled.skeleton).toBe(titled.skeleton)
    expect(blank.skeleton).toBe(titled.skeleton)
    expect(long.skeleton).toBe(titled.skeleton)
    // Exactly one label element in every branch: no second span appears
    // alongside the title, and none disappears without it.
    for (const row of [titled, untitled, blank, long]) {
      expect(row.skeleton.match(/my-requests__preview/g)).toHaveLength(1)
    }
  })

  it('renders a 120-char slug in full — no JS truncation, no structural change', async () => {
    expect(LONG_SLUG).toHaveLength(120)
    expect(LONG_SLUG).not.toContain(' ')

    const long = await renderRow({ title: LONG_SLUG })

    // Verbatim in the DOM: the whole slug, and no ellipsis inserted by JS. The
    // clipping is the stylesheet's job (asserted separately below).
    expect(long.text).toBe(LONG_SLUG)
    expect(long.text).toHaveLength(120)
    expect(long.text).not.toContain('…')
    expect(long.text).not.toContain('...')
    // Emphatically not run through the 80-char message preview rule.
    expect(long.text).not.toBe(`${LONG_SLUG.slice(0, 79)}…`)
    // The label element holds it directly — no nested wrapper was introduced
    // to carry the long case.
    expect(long.label.children).toHaveLength(0)
  })

  it('still shows the status and date beside the label, titled or not', async () => {
    for (const title of [SLUG, null]) {
      const row = await renderRow({ title })
      expect(row.accessibleText).toContain('building')
      expect(row.accessibleText).toContain('Aug 27, 2026')
    }
  })
})

/* -- Criterion 2: the build-view header --------------------------------------- */

function header() {
  return document.querySelector('.watch-build__header')
}

describe('DAN-91 tester · build header', () => {
  it('shows the title in the header, beside the View in Linear link', async () => {
    render(
      <WatchBuild promptId="fr-t1" linearProjectUrl={LINEAR_URL} title={SLUG} />,
    )

    const link = await screen.findByRole('link', { name: 'View in Linear' })
    const shown = within(header()).getByText(SLUG)
    expect(shown).toBeInTheDocument()
    expect(shown.textContent).toBe(SLUG)
    // Same header element, not somewhere else on the page.
    expect(header().contains(link)).toBe(true)
    expect(header().contains(shown)).toBe(true)
  })

  it('renders nothing title-related when the title is null', async () => {
    render(
      <WatchBuild promptId="fr-t1" linearProjectUrl={LINEAR_URL} title={null} />,
    )
    await screen.findByRole('link', { name: 'View in Linear' })

    expect(header().querySelector('.watch-build__title')).toBeNull()
    // No empty slot left behind either: every child of the header carries text.
    for (const child of header().children) {
      expect(child.textContent.trim()).not.toBe('')
    }
    // The header's skeleton is exactly the DAN-81 one, with nothing added.
    expect(skeleton(header())).toBe(
      'header.watch-build__header(h2,a.watch-build__linear-link,' +
        'p.watch-build__cost(span.watch-build__cost-figure))',
    )
  })

  it('treats an omitted prop and a blank title as absent', async () => {
    for (const props of [{}, { title: '' }, { title: '   ' }]) {
      const { unmount } = render(
        <WatchBuild promptId="fr-t1" linearProjectUrl={LINEAR_URL} {...props} />,
      )
      await screen.findByRole('link', { name: 'View in Linear' })
      expect(header().querySelector('.watch-build__title')).toBeNull()
      unmount()
    }
  })

  it('adds only the title node when a title is present (DAN-81 header intact)', async () => {
    const { unmount } = render(
      <WatchBuild promptId="fr-t1" linearProjectUrl={LINEAR_URL} title={null} />,
    )
    await screen.findByRole('link', { name: 'View in Linear' })
    const without = skeleton(header())
    unmount()

    render(
      <WatchBuild promptId="fr-t1" linearProjectUrl={LINEAR_URL} title={SLUG} />,
    )
    await screen.findByRole('link', { name: 'View in Linear' })
    const withTitle = skeleton(header())

    expect(withTitle).not.toBe(without)
    // The difference is exactly one inserted span — remove it and the DAN-81
    // header is byte-identical.
    expect(withTitle.replace('span.watch-build__title,', '')).toBe(without)
  })

  it('keeps the Linear link and the planning cost regardless of the title (DAN-81 regression)', async () => {
    for (const title of [SLUG, null, LONG_SLUG, '   ']) {
      const { unmount } = render(
        <WatchBuild
          promptId="fr-t1"
          linearProjectUrl={LINEAR_URL}
          title={title}
        />,
      )

      const link = await screen.findByRole('link', { name: 'View in Linear' })
      expect(link).toHaveAttribute('href', LINEAR_URL)
      expect(link).toHaveAttribute('target', '_blank')
      expect((link.getAttribute('rel') ?? '').split(/\s+/)).toContain('noopener')

      const stat = screen.getByText(/Planning cost/)
      expect(stat).toHaveTextContent('$0.1234')
      expect(stat).toHaveTextContent(/7\s*calls/)
      // And the DAG below the header is untouched.
      expect(screen.getByRole('link', { name: 'DAN-99' })).toBeInTheDocument()
      unmount()
    }
  })

  it('shows the title even when there is no Linear link at all', async () => {
    render(<WatchBuild promptId="fr-t1" linearProjectUrl={null} title={SLUG} />)

    await screen.findByRole('link', { name: 'DAN-99' })
    expect(within(header()).getByText(SLUG)).toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: 'View in Linear' }),
    ).not.toBeInTheDocument()
  })

  it('prints a 120-char slug verbatim in the header, with no JS truncation', async () => {
    render(
      <WatchBuild
        promptId="fr-t1"
        linearProjectUrl={LINEAR_URL}
        title={LONG_SLUG}
      />,
    )
    await screen.findByRole('link', { name: 'DAN-99' })

    const el = header().querySelector('.watch-build__title')
    expect(el.textContent).toBe(LONG_SLUG)
    expect(el.textContent).toHaveLength(120)
    expect(el.textContent).not.toContain('…')
    expect(el.children).toHaveLength(0)
  })
})

/* -- Criterion 2b: the title actually reaches the header from the request ----- */

const passingCriteria = {
  notTooBig: { pass: true, reason: 'Fits one ticket' },
  notAmbiguous: { pass: true, reason: 'Concrete scope' },
  noBlockedDependencies: { pass: true, reason: 'Nothing blocked' },
}

async function approveInto(built) {
  vi.mocked(startFeatureRequest).mockResolvedValue(
    request({ status: 'open', messages: [], title: null }),
  )
  vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
    request({
      status: 'open',
      entranceCriteria: passingCriteria,
      approvable: true,
      title: null,
    }),
  )
  vi.mocked(approveFeatureRequestPlan).mockResolvedValue(built)
  vi.mocked(listFeatureRequests).mockResolvedValue([])

  render(<FeatureRequestView onBack={() => {}} />)
  fireEvent.change(screen.getByLabelText('Message'), {
    target: { value: FIRST_MESSAGE },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await screen.findByRole('list', { name: 'Conversation' })
  fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }))
}

describe('DAN-91 tester · title wiring through the view', () => {
  it("passes the approved request's title into the build header", async () => {
    await approveInto(request({ status: 'building', title: SLUG }))

    await screen.findByRole('link', { name: 'View in Linear' })
    expect(within(header()).getByText(SLUG)).toBeInTheDocument()
  })

  it('shows no title when the approved request has none', async () => {
    await approveInto(request({ status: 'building', title: null }))

    await screen.findByRole('link', { name: 'View in Linear' })
    expect(header().querySelector('.watch-build__title')).toBeNull()
    expect(screen.getByText(/Planning cost/)).toBeInTheDocument()
  })
})

/* -- Criterion 3: api.js selects the field ------------------------------------ */

describe('DAN-91 tester · FeatureRequest selection set', () => {
  // The real api.js over a stubbed fetch — importActual unmocks this module
  // only; its own import of ./auth.js still resolves to the mock above, so no
  // Firebase SDK is touched.
  async function realApi() {
    return vi.importActual('./api.js')
  }

  function stubGql(data) {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  function payload(overrides = {}) {
    return {
      id: 'fr1',
      status: 'building',
      model: 'claude-opus-5',
      createdAt: '2026-08-27T10:00:00.000Z',
      approvable: false,
      linearProjectUrl: LINEAR_URL,
      title: SLUG,
      messages: [],
      entranceCriteria: null,
      ...overrides,
    }
  }

  it('sends `title` as a FeatureRequest field on every operation that selects one', async () => {
    const api = await realApi()
    const cases = [
      [() => api.listFeatureRequests(), { featureRequests: [payload()] }],
      [() => api.featureRequest('fr1'), { featureRequest: payload() }],
      [
        () => api.startFeatureRequest('claude-opus-5'),
        { startFeatureRequest: payload() },
      ],
      [
        () => api.sendFeatureRequestMessage('fr1', 'hi'),
        { sendFeatureRequestMessage: payload() },
      ],
    ]

    for (const [call, data] of cases) {
      const fetchMock = stubGql(data)
      await call()

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('/api/graphql')
      const body = JSON.parse(init.body)

      // `title` must be a standalone field in the selection, not a substring of
      // some other token (`titleSlug`, a comment, an argument value) and not
      // borrowed from the TicketProgress set, which is a different query.
      expect(body.query).toMatch(/(^|\s)title(\s|\})/)
      // It sits in the FeatureRequest selection set, next to the fields the
      // same set already carries.
      expect(body.query).toContain('linearProjectUrl title')
      // The pre-existing fields are all still selected — the edit added a
      // field rather than rewriting the set.
      for (const field of [
        'id',
        'status',
        'model',
        'createdAt',
        'approvable',
        'linearProjectUrl',
        'messages',
        'entranceCriteria',
      ]) {
        expect(body.query).toContain(field)
      }
      vi.unstubAllGlobals()
    }
  })

  it('resolves the slug untouched and a null title as null', async () => {
    const api = await realApi()
    stubGql({
      featureRequests: [
        payload({ id: 'a', title: SLUG }),
        payload({ id: 'b', title: null }),
        payload({ id: 'c', title: LONG_SLUG }),
      ],
    })

    const list = await api.listFeatureRequests()
    expect(list.map((r) => r.title)).toEqual([SLUG, null, LONG_SLUG])
  })
})

/* -- Criterion 4: long slugs clip instead of breaking the layout -------------- */

// The DOM assertions above prove the app never truncates a slug itself. That is
// only half the criterion: something has to stop a 120-character unbroken word
// from widening its flex row. jsdom does not lay out, so the stylesheet is read
// and its cascade resolved for the two elements that hold a slug.

const CSS = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'styles.css'),
  'utf8',
)

// Declarations that apply to a bare class selector, in source order (later wins).
// Only exact single-class rules are considered, which is all this sheet uses for
// these two elements.
function resolve(selector) {
  const decls = {}
  const rules = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(rules))) {
    const selectors = m[1].split(',').map((s) => s.trim())
    if (!selectors.includes(selector)) continue
    for (const part of m[2].split(';')) {
      const i = part.indexOf(':')
      if (i === -1) continue
      decls[part.slice(0, i).trim()] = part.slice(i + 1).trim()
    }
  }
  return decls
}

describe('DAN-91 tester · long slugs clip rather than break the layout', () => {
  it('gives the my-requests label the full one-line clip, min-width included', async () => {
    const label = resolve('.my-requests__preview')

    // The DAN-74 clip is still there…
    expect(label.overflow).toBe('hidden')
    expect(label['text-overflow']).toBe('ellipsis')
    expect(label['white-space']).toBe('nowrap')
    expect(label.flex).toBe('1')
    // …and min-width: 0 is what makes it engage for an unbreakable word. A flex
    // item defaults to min-width: auto, i.e. its min-content width — for a
    // 120-char slug with no break opportunity that is the whole word, so
    // without this the row widens instead of clipping.
    expect(label['min-width']).toBe('0')

    // The class the rules are written against is the one actually rendered.
    const row = await renderRow({ title: LONG_SLUG })
    expect(row.label.classList.contains('my-requests__preview')).toBe(true)
  })

  it('clips the build-header title and caps its share of the header', async () => {
    const title = resolve('.watch-build__title')

    expect(title.overflow).toBe('hidden')
    expect(title['text-overflow']).toBe('ellipsis')
    expect(title['white-space']).toBe('nowrap')
    expect(title['min-width']).toBe('0')
    // A cap is what keeps a long slug from crowding out the link and the cost
    // stat in the shared flex row.
    expect(title['max-width']).toBeTruthy()

    render(
      <WatchBuild
        promptId="fr-t1"
        linearProjectUrl={LINEAR_URL}
        title={LONG_SLUG}
      />,
    )
    await screen.findByRole('link', { name: 'DAN-99' })
    expect(
      header().querySelector('.watch-build__title'),
    ).toBeInTheDocument()
  })
})
