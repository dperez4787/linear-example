import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { listFeatureRequests } from './api.js'
import MyRequests from './MyRequests.jsx'

// DAN-94 in the My-requests list: a session that has reached the terminal
// "shipped" status must read as a different state from "building" and
// "gathering", not as a louder version of either.
//
// The word is the assertion. The chip renders `request.status` verbatim, so the
// accessible text is the signal a screen reader and a user both get; the
// modifier class is checked alongside it because it is the hook the stylesheet
// hangs the three colours on, and a shared class would mean three states
// painted identically. Colours themselves are not asserted here — the repo's
// rule is that tests never assert on styles.
//
// Mocked api.js, same idiom as the DAN-74/DAN-91 suites; the list fetches for
// itself, so rendering MyRequests directly is enough.
vi.mock('./api.js', () => ({
  listFeatureRequests: vi.fn(),
}))

function makeRequest(overrides) {
  return {
    id: 'fr-x',
    status: 'gathering',
    model: 'claude-opus-5',
    createdAt: '2026-08-27T10:00:00.000Z',
    title: null,
    messages: [{ role: 'user', content: 'Please add CSV export' }],
    entranceCriteria: null,
    approvable: false,
    linearProjectUrl: null,
    ...overrides,
  }
}

// One session per status, newest first so the rendered order is predictable.
const shipped = makeRequest({
  id: 'fr-shipped',
  status: 'shipped',
  title: 'add_csv_export',
  createdAt: '2026-08-27T12:00:00.000Z',
})
const building = makeRequest({
  id: 'fr-building',
  status: 'building',
  title: 'change_buttons_to_green',
  createdAt: '2026-08-27T11:00:00.000Z',
})
const gathering = makeRequest({
  id: 'fr-gathering',
  status: 'gathering',
  createdAt: '2026-08-27T10:00:00.000Z',
})

// The rows in render order. The list sorts newest first, so the fixtures above
// come back as [shipped, building, gathering].
function rows() {
  return within(screen.getByRole('region', { name: 'My requests' })).getAllByRole(
    'button',
  )
}

beforeEach(() => {
  vi.mocked(listFeatureRequests).mockReset()
  vi.mocked(listFeatureRequests).mockResolvedValue([shipped, building, gathering])
})

describe('DAN-94 · the terminal status renders distinctly in My requests', () => {
  it('shows "shipped" as the row status, not "building"', async () => {
    render(<MyRequests onOpen={() => {}} />)

    const row = await screen.findByText('add_csv_export')
    const item = row.closest('button')
    expect(within(item).getByText('shipped')).toBeTruthy()
    expect(within(item).queryByText('building')).toBeNull()
    expect(within(item).queryByText('gathering')).toBeNull()
  })

  it('gives each of the three statuses its own word and its own modifier class', async () => {
    render(<MyRequests onOpen={() => {}} />)
    await screen.findByText('add_csv_export')

    const [shippedRow, buildingRow, gatheringRow] = rows()
    const chipOf = (row) => row.querySelector('[class*="my-requests__status"]')

    const chips = {
      shipped: chipOf(shippedRow),
      building: chipOf(buildingRow),
      gathering: chipOf(gatheringRow),
    }

    // The word: exactly the status, one per row, all three different.
    expect(chips.shipped.textContent).toBe('shipped')
    expect(chips.building.textContent).toBe('building')
    expect(chips.gathering.textContent).toBe('gathering')

    // The hook the stylesheet uses: a distinct modifier per status, so the
    // three can never collapse into one paint.
    const modifiers = Object.values(chips).map((chip) =>
      [...chip.classList].find((c) => c.startsWith('my-requests__status--')),
    )
    expect(modifiers).toEqual([
      'my-requests__status--shipped',
      'my-requests__status--building',
      'my-requests__status--gathering',
    ])
    expect(new Set(modifiers).size).toBe(3)
  })

  it('a shipped row is still clickable and still hands the whole request to onOpen', async () => {
    const onOpen = vi.fn()
    render(<MyRequests onOpen={onOpen} />)
    await screen.findByText('add_csv_export')

    rows()[0].click()
    expect(onOpen).toHaveBeenCalledWith(shipped)
  })
})

describe('DAN-94 · the stylesheet paints the three statuses apart', () => {
  it('gives .my-requests__status--shipped a colour of its own', async () => {
    // Not a style assertion about how the app looks — a check that the new
    // status has a rule at all and that it is not the building green, which is
    // the one way "distinct from building" could silently regress.
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = path.dirname(fileURLToPath(import.meta.url))
    const css = fs.readFileSync(path.join(here, 'styles.css'), 'utf8')

    const rule = css.match(/\.my-requests__status--shipped\s*\{([^}]*)\}/)
    expect(rule).not.toBeNull()
    expect(rule[1]).toMatch(/color:/)
    expect(rule[1]).not.toMatch(/#1a7f37/)
  })
})
