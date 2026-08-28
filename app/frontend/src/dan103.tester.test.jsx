import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { act, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import CostBreakdown, {
  formatUsd,
  grandTotalUsd,
} from './CostBreakdown.jsx'
import MyRequests from './MyRequests.jsx'
import WatchBuild, { POLL_INTERVAL_MS } from './WatchBuild.jsx'
import {
  featureRequestActivity,
  featureRequestCost,
  featureRequestProgress,
  listFeatureRequests,
  ticketCosts,
} from './api.js'

// DAN-103 TESTER SUITE — written independently from the ticket's acceptance
// criteria, not from the developer's tests. What it proves, and how:
//
//   1. The grand total is ARITHMETIC, checked as a pure function across the
//      cases a renderer cannot reach: null planning, [] and null rows, many
//      rows, IEEE-754 drift (0.1 + 0.2), a legitimately zero total, and a
//      large figure that must stay in plain decimal notation.
//   2. Per-row rendering carries ticket / leg / model / 4dp dollars, and a row
//      whose model differs from the session's model is shown with ITS OWN
//      model — the per-leg model is data, not a repeat of the session header.
//   3. The empty and legacy paths are proven STRUCTURALLY: the build view's
//      whole tag+class skeleton with [] rows, with a read that never lands,
//      and with a backend that has no ticketCosts field at all, are compared
//      as strings — a layout that grew or lost an element in any of those
//      branches fails here even though it would still "look fine".
//   4. ONE TIMER: under fake timers all four reads advance in lockstep hop for
//      hop, and an advance of one millisecond less than the interval fires
//      nothing at all — which is what rules out a second cadence.
//   5. The poll stops on all-DONE and on unmount, with no post-unmount state
//      update (React's act/update warnings are treated as failures).
//   6. Soft failure is directional: a ticketCosts blip keeps the last good
//      rows and must NOT stale the DAG; a progress blip stales the DAG and
//      must NOT blank the breakdown.
//   7. The my-requests model chip, asserted in both of its halves — the
//      attribute on the row and the stylesheet rule that turns it into visible
//      text — plus the honest record of what that combination does NOT prove.
//
// api.js is mocked module-wide (the DAN-53..91 idiom); CostBreakdown is
// presentation-only so its arithmetic and row tests hand props straight in.
vi.mock('./api.js', () => ({
  featureRequestProgress: vi.fn(),
  featureRequestCost: vi.fn(),
  featureRequestActivity: vi.fn(),
  ticketCosts: vi.fn(),
  listFeatureRequests: vi.fn(),
}))

/* -- fixtures ---------------------------------------------------------------- */

const inFlight = [
  {
    issueId: 'iss-1',
    identifier: 'DAN-90',
    title: 'Backend contract',
    state: 'IN_PROGRESS',
    issueUrl: 'https://linear.app/tester-org/issue/DAN-90',
    prUrl: null,
    blockedBy: [],
  },
]

const everyTicketDone = [{ ...inFlight[0], state: 'DONE' }]

const planning = { calls: 7, tokensIn: 5120, tokensOut: 2048, costUsd: 0.1234 }

// The session ran on claude-opus-5; the test leg ran on something else. That
// difference is the point of the per-row model column.
const SESSION_MODEL = 'claude-opus-5'
const OTHER_MODEL = 'gpt-5.6-terra'

function row(overrides = {}) {
  return {
    ticketIdentifier: 'DAN-90',
    leg: 'develop',
    model: SESSION_MODEL,
    costUsd: 0.21,
    recordedAt: '2026-08-27T10:00:00.000Z',
    ...overrides,
  }
}

const twoLegs = [
  row(),
  row({
    leg: 'test',
    model: OTHER_MODEL,
    costUsd: 0.09,
    recordedAt: '2026-08-27T10:05:00.000Z',
  }),
]

function breakdown() {
  return screen.getByRole('region', { name: 'Cost breakdown' })
}

// An element reduced to nothing but its shape: tag name, sorted class list and
// children, every text node dropped. Two renders with the same string are the
// same layout whatever words are in them.
function skeleton(el) {
  const classes = [...el.classList].sort().join('.')
  const kids = [...el.children].map(skeleton).join(',')
  return `${el.tagName.toLowerCase()}${classes ? `.${classes}` : ''}${
    kids ? `(${kids})` : ''
  }`
}

beforeEach(() => {
  vi.mocked(featureRequestProgress).mockReset()
  vi.mocked(featureRequestCost).mockReset()
  vi.mocked(featureRequestActivity).mockReset()
  vi.mocked(ticketCosts).mockReset()
  vi.mocked(listFeatureRequests).mockReset()
  vi.mocked(featureRequestProgress).mockResolvedValue(inFlight)
  vi.mocked(featureRequestCost).mockResolvedValue(planning)
  vi.mocked(featureRequestActivity).mockResolvedValue([])
  vi.mocked(ticketCosts).mockResolvedValue(twoLegs)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/* == 1. The grand total as arithmetic ======================================== */

describe('DAN-103 tester · grand total is arithmetic, not a rendering', () => {
  it('sums planning plus every leg', () => {
    expect(grandTotalUsd(planning, twoLegs)).toBeCloseTo(0.4234, 12)
    expect(formatUsd(grandTotalUsd(planning, twoLegs))).toBe('$0.4234')
  })

  it('treats a null/absent planning ledger as zero rather than suppressing the total', () => {
    expect(grandTotalUsd(null, twoLegs)).toBeCloseTo(0.3, 12)
    expect(grandTotalUsd(undefined, twoLegs)).toBeCloseTo(0.3, 12)
    // A planning object that somehow carries no figure is also zero, not NaN.
    expect(grandTotalUsd({}, twoLegs)).toBeCloseTo(0.3, 12)
    expect(Number.isNaN(grandTotalUsd({}, twoLegs))).toBe(false)
  })

  it('is the planning cost alone for [] rows and for a read that never landed', () => {
    expect(grandTotalUsd(planning, [])).toBe(0.1234)
    expect(grandTotalUsd(planning, null)).toBe(0.1234)
    expect(grandTotalUsd(planning, undefined)).toBe(0.1234)
  })

  it('sums many rows — every leg counted exactly once, in any order', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      row({
        ticketIdentifier: `DAN-${100 + i}`,
        costUsd: 0.01,
        recordedAt: `2026-08-27T10:${String(i).padStart(2, '0')}:00.000Z`,
      }),
    )
    // 25 * 0.01 = 0.25, plus planning 0.1234.
    expect(grandTotalUsd(planning, many)).toBeCloseTo(0.3734, 12)
    expect(formatUsd(grandTotalUsd(planning, many))).toBe('$0.3734')
    // Reversing the order cannot change the answer.
    expect(formatUsd(grandTotalUsd(planning, [...many].reverse()))).toBe(
      '$0.3734',
    )
  })

  it('survives IEEE-754 drift: 0.1 + 0.2 displays as exactly "$0.3000"', () => {
    const total = grandTotalUsd({ costUsd: 0.1 }, [row({ costUsd: 0.2 })])
    // The raw sum really is inexact — this is the trap the formatter must close.
    expect(total).not.toBe(0.3)
    expect(total).toBeCloseTo(0.3, 12)
    expect(formatUsd(total)).toBe('$0.3000')
    expect(formatUsd(total)).not.toContain('0.30000000000000004')

    // The same trap one layer deeper: three legs of 0.1.
    const drift = grandTotalUsd(null, [
      row({ costUsd: 0.1 }),
      row({ costUsd: 0.1 }),
      row({ costUsd: 0.1 }),
    ])
    expect(drift).not.toBe(0.3)
    expect(formatUsd(drift)).toBe('$0.3000')
  })

  it('renders a legitimately zero total as "$0.0000", never blank and never "-$0.0000"', () => {
    expect(grandTotalUsd(null, [])).toBe(0)
    expect(formatUsd(grandTotalUsd(null, []))).toBe('$0.0000')
    // Free legs really can record 0: the total is a real zero, not "no data".
    const freeLegs = grandTotalUsd({ costUsd: 0 }, [
      row({ costUsd: 0 }),
      row({ costUsd: 0, leg: 'test' }),
    ])
    expect(formatUsd(freeLegs)).toBe('$0.0000')
    expect(formatUsd(freeLegs)).not.toMatch(/^\$-/)
  })

  it('keeps a large total in plain decimal — no exponential notation', () => {
    const big = grandTotalUsd({ costUsd: 4321.5 }, [
      row({ costUsd: 1234567.891 }),
      row({ costUsd: 8765432.109, leg: 'test' }),
    ])
    const shown = formatUsd(big)
    expect(shown).toBe('$10004321.5000')
    expect(shown).not.toMatch(/e[+-]/i)
    expect(shown).toMatch(/^\$\d+\.\d{4}$/)
  })

  it('always shows exactly four decimals — rounding and padding both', () => {
    expect(formatUsd(0)).toBe('$0.0000')
    expect(formatUsd(1)).toBe('$1.0000')
    expect(formatUsd(0.5)).toBe('$0.5000')
    expect(formatUsd(0.00005)).toBe('$0.0001')
    expect(formatUsd(0.123456)).toBe('$0.1235')
    for (const value of [0, 1, 0.5, 0.00005, 0.123456, 9999.99999]) {
      expect(formatUsd(value)).toMatch(/^\$\d+\.\d{4}$/)
    }
  })
})

/* == 2. Per-row rendering ==================================================== */

describe('DAN-103 tester · per-leg rows', () => {
  it('shows ticket, leg, model and dollars to 4dp for every leg, plus planning and total', () => {
    render(<CostBreakdown planningCost={planning} rows={twoLegs} />)
    const section = breakdown()
    const items = within(section).getAllByRole('listitem')

    // planning + 2 legs + total.
    expect(items).toHaveLength(4)
    expect(items[0]).toHaveTextContent('Planning')
    expect(items[0]).toHaveTextContent('$0.1234')

    expect(items[1]).toHaveTextContent('DAN-90')
    expect(items[1]).toHaveTextContent('develop')
    expect(items[1]).toHaveTextContent(SESSION_MODEL)
    expect(items[1]).toHaveTextContent('$0.2100')

    expect(items[2]).toHaveTextContent('DAN-90')
    expect(items[2]).toHaveTextContent('test')
    expect(items[2]).toHaveTextContent(OTHER_MODEL)
    expect(items[2]).toHaveTextContent('$0.0900')

    expect(items[3]).toHaveTextContent('Grand total')
    expect(items[3]).toHaveTextContent('$0.4234')
  })

  it('shows each row its OWN model — a leg that ran on a different model is not overwritten by the session model', () => {
    render(
      <CostBreakdown
        planningCost={planning}
        rows={[
          row({ ticketIdentifier: 'DAN-90', model: SESSION_MODEL }),
          row({
            ticketIdentifier: 'DAN-91',
            leg: 'test',
            model: OTHER_MODEL,
            costUsd: 0.09,
          }),
          row({
            ticketIdentifier: 'DAN-92',
            leg: 'develop',
            model: 'gemini-3-pro',
            costUsd: 0.05,
          }),
        ]}
      />,
    )
    const items = within(breakdown()).getAllByRole('listitem')
    const legRows = items.slice(1, 4)

    // Three legs, three distinct models, each on its own row and none of them
    // repeated onto a sibling.
    expect(legRows[0]).toHaveTextContent(SESSION_MODEL)
    expect(legRows[1]).toHaveTextContent(OTHER_MODEL)
    expect(legRows[1]).not.toHaveTextContent(SESSION_MODEL)
    expect(legRows[2]).toHaveTextContent('gemini-3-pro')
    expect(legRows[2]).not.toHaveTextContent(SESSION_MODEL)

    const models = legRows.map(
      (li) => li.querySelector('.cost-breakdown__model').textContent,
    )
    expect(models).toEqual([SESSION_MODEL, OTHER_MODEL, 'gemini-3-pro'])
  })

  it('keeps one row per leg even when a ticket records the same leg twice (a bounced re-run)', () => {
    render(
      <CostBreakdown
        planningCost={null}
        rows={[
          row({ leg: 'develop', costUsd: 0.2, recordedAt: '2026-08-27T10:00:00.000Z' }),
          row({ leg: 'develop', costUsd: 0.3, recordedAt: '2026-08-27T12:00:00.000Z' }),
        ]}
      />,
    )
    const items = within(breakdown()).getAllByRole('listitem')
    // Two legs + total, no planning line (null ledger).
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent('$0.2000')
    expect(items[1]).toHaveTextContent('$0.3000')
    expect(items[2]).toHaveTextContent('Grand total')
    expect(items[2]).toHaveTextContent('$0.5000')
    // Both re-runs are counted — not de-duplicated into one.
    expect(within(breakdown()).queryByText('$0.3000')).toBeInTheDocument()
  })

  it('omits the planning line but keeps the rows and the total when no ledger has landed', () => {
    render(<CostBreakdown planningCost={null} rows={twoLegs} />)
    const section = breakdown()
    expect(within(section).queryByText('Planning')).not.toBeInTheDocument()
    expect(within(section).getByText('Grand total')).toBeInTheDocument()
    expect(within(section).getByText('$0.3000')).toBeInTheDocument()
  })

  it('renders the rendered total from the same function the arithmetic tests exercise', () => {
    const rows = [row({ costUsd: 0.1 }), row({ costUsd: 0.2, leg: 'test' })]
    render(<CostBreakdown planningCost={{ costUsd: 0.05 }} rows={rows} />)
    const items = within(breakdown()).getAllByRole('listitem')
    expect(items[items.length - 1]).toHaveTextContent(
      formatUsd(grandTotalUsd({ costUsd: 0.05 }, rows)),
    )
    expect(items[items.length - 1]).toHaveTextContent('$0.3500')
  })
})

/* == 3. Empty / legacy structure ============================================= */

describe('DAN-103 tester · empty and legacy render exactly today’s layout', () => {
  it('renders nothing at all for [] and for a never-landed read', () => {
    const { container: emptyRows } = render(
      <CostBreakdown planningCost={planning} rows={[]} />,
    )
    expect(emptyRows.innerHTML).toBe('')
    const { container: nullRows } = render(
      <CostBreakdown planningCost={planning} rows={null} />,
    )
    expect(nullRows.innerHTML).toBe('')
  })

  async function buildSkeleton(ticketCostsImpl) {
    ticketCostsImpl(vi.mocked(ticketCosts))
    const { unmount } = render(<WatchBuild promptId="fr1" />)
    await screen.findByRole('link', { name: 'DAN-90' })
    await act(async () => {})
    const section = screen.getByRole('region', { name: 'Build progress' })
    const shape = skeleton(section)
    unmount()
    return shape
  }

  it('gives byte-identical structure for [], for a failing read, and for a backend with no field at all', async () => {
    const empty = await buildSkeleton((m) => m.mockResolvedValue([]))
    const failing = await buildSkeleton((m) =>
      m.mockRejectedValue(Object.assign(new Error('not found'), {
        extensions: { code: 'NOT_FOUND' },
      })),
    )
    // The DAN-101 backend has not shipped: the field resolves undefined.
    const noField = await buildSkeleton((m) => m.mockResolvedValue(undefined))

    expect(failing).toBe(empty)
    expect(noField).toBe(empty)
    // And none of those three grew a breakdown panel.
    expect(empty).not.toContain('cost-breakdown')
  })

  it('adds the breakdown — and only the breakdown — once legs exist', async () => {
    const empty = await buildSkeleton((m) => m.mockResolvedValue([]))
    const withRows = await buildSkeleton((m) => m.mockResolvedValue(twoLegs))

    expect(withRows).not.toBe(empty)
    expect(withRows).toContain('section.cost-breakdown')
    // Everything that was there before is still there, unchanged, and the new
    // panel is appended rather than wrapped around the old layout.
    expect(withRows.startsWith(empty.slice(0, empty.length - 1))).toBe(true)
  })

  it('keeps the DAN-81 planning-cost header stat in the empty case', async () => {
    vi.mocked(ticketCosts).mockResolvedValue([])
    render(<WatchBuild promptId="fr1" />)
    await screen.findByRole('link', { name: 'DAN-90' })
    await act(async () => {})
    expect(screen.getByText(/Planning cost/)).toHaveTextContent('$0.1234')
    expect(
      screen.queryByRole('region', { name: 'Cost breakdown' }),
    ).not.toBeInTheDocument()
  })
})

/* == 4. One timer ============================================================ */

describe('DAN-103 tester · the ticketCosts read rides the existing tick', () => {
  it('advances all four reads in lockstep, hop for hop, over several intervals', async () => {
    vi.useFakeTimers()
    render(<WatchBuild promptId="fr1" />)

    await act(async () => {})
    const counts = () => [
      vi.mocked(featureRequestProgress).mock.calls.length,
      vi.mocked(featureRequestCost).mock.calls.length,
      vi.mocked(featureRequestActivity).mock.calls.length,
      vi.mocked(ticketCosts).mock.calls.length,
    ]
    expect(counts()).toEqual([1, 1, 1, 1])
    expect(ticketCosts).toHaveBeenCalledWith('fr1')

    for (const expected of [2, 3, 4, 5]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      })
      expect(counts()).toEqual([expected, expected, expected, expected])
    }
  })

  it('fires nothing at all on a sub-interval advance — there is no second cadence', async () => {
    vi.useFakeTimers()
    render(<WatchBuild promptId="fr1" />)
    await act(async () => {})
    expect(ticketCosts).toHaveBeenCalledTimes(1)

    // Every slice strictly inside one interval, cumulatively still short of it.
    for (const step of [1, 100, 1000, POLL_INTERVAL_MS - 1102]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(step)
      })
      expect(vi.mocked(ticketCosts).mock.calls.length).toBe(1)
      expect(vi.mocked(featureRequestProgress).mock.calls.length).toBe(1)
    }
    // One more millisecond completes the interval and every read hops together.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(ticketCosts).toHaveBeenCalledTimes(2)
    expect(featureRequestProgress).toHaveBeenCalledTimes(2)
    expect(featureRequestCost).toHaveBeenCalledTimes(2)
    expect(featureRequestActivity).toHaveBeenCalledTimes(2)
  })

  it('runs exactly one pending timer between hops', async () => {
    vi.useFakeTimers()
    render(<WatchBuild promptId="fr1" />)
    await act(async () => {})
    expect(vi.getTimerCount()).toBe(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(vi.getTimerCount()).toBe(1)
  })

  it('picks up newly recorded legs on the shared tick, total included', async () => {
    vi.useFakeTimers()
    vi.mocked(ticketCosts).mockResolvedValue([row()])
    render(<WatchBuild promptId="fr1" />)
    await act(async () => {})
    expect(within(breakdown()).getByText('$0.3334')).toBeInTheDocument()

    vi.mocked(ticketCosts).mockResolvedValue(twoLegs)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    const section = breakdown()
    expect(within(section).getByText('test')).toBeInTheDocument()
    expect(within(section).getByText(OTHER_MODEL)).toBeInTheDocument()
    expect(within(section).getByText('$0.4234')).toBeInTheDocument()
  })
})

/* == 5. Stopping ============================================================= */

describe('DAN-103 tester · the rider stops when the poll stops', () => {
  it('stops on all-DONE and leaves the final breakdown on screen', async () => {
    vi.useFakeTimers()
    vi.mocked(featureRequestProgress).mockResolvedValue(everyTicketDone)
    render(<WatchBuild promptId="fr1" />)
    await act(async () => {})
    expect(ticketCosts).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 10)
    })
    expect(ticketCosts).toHaveBeenCalledTimes(1)
    expect(featureRequestProgress).toHaveBeenCalledTimes(1)
    expect(within(breakdown()).getByText('$0.4234')).toBeInTheDocument()
  })

  it('stops on unmount, with no read and no state update after teardown', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers()
    const { unmount } = render(<WatchBuild promptId="fr1" />)
    await act(async () => {})
    expect(ticketCosts).toHaveBeenCalledTimes(1)

    unmount()
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5)
    })
    expect(ticketCosts).toHaveBeenCalledTimes(1)
    expect(featureRequestProgress).toHaveBeenCalledTimes(1)
    // React shouts on stdout when a component sets state after unmount; no
    // shout means the cancelled flag really did guard every setter.
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('does not write state from a read that resolves after unmount', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    let releaseCosts
    vi.mocked(ticketCosts).mockImplementation(
      () => new Promise((resolve) => {
        releaseCosts = () => resolve(twoLegs)
      }),
    )
    const { unmount } = render(<WatchBuild promptId="fr1" />)
    await act(async () => {})
    unmount()
    // The in-flight ticketCosts read lands only now, after teardown.
    await act(async () => {
      releaseCosts()
      await Promise.resolve()
    })
    expect(consoleError).not.toHaveBeenCalled()
  })
})

/* == 6. Directional soft failure ============================================= */

describe('DAN-103 tester · failures degrade in the right direction', () => {
  it('keeps the last good rows on a ticketCosts failure and never stales the DAG', async () => {
    vi.useFakeTimers()
    render(<WatchBuild promptId="fr1" />)
    await act(async () => {})
    expect(within(breakdown()).getByText('$0.4234')).toBeInTheDocument()

    vi.mocked(ticketCosts).mockRejectedValue(new Error('gateway timeout'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })

    const section = breakdown()
    expect(within(section).getByText('$0.2100')).toBeInTheDocument()
    expect(within(section).getByText('$0.0900')).toBeInTheDocument()
    expect(within(section).getByText('$0.4234')).toBeInTheDocument()
    // The DAG is untouched: no stale note, still polling.
    expect(screen.queryByText(/Live view stale/)).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'DAN-90' })).toBeInTheDocument()

    // And it recovers on the next good read without a remount.
    vi.mocked(ticketCosts).mockResolvedValue([
      ...twoLegs,
      row({ ticketIdentifier: 'DAN-91', costUsd: 0.5, recordedAt: '2026-08-27T11:00:00.000Z' }),
    ])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(within(breakdown()).getByText('$0.9234')).toBeInTheDocument()
  })

  it('stales the DAG on a progress failure without blanking the breakdown', async () => {
    vi.useFakeTimers()
    render(<WatchBuild promptId="fr1" />)
    await act(async () => {})
    expect(within(breakdown()).getByText('$0.4234')).toBeInTheDocument()

    vi.mocked(featureRequestProgress).mockRejectedValue(new Error('boom'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })

    expect(screen.getByText(/Live view stale/)).toBeInTheDocument()
    // The breakdown keeps rendering — a DAG blip is not a cost blip.
    const section = breakdown()
    expect(within(section).getByText('$0.2100')).toBeInTheDocument()
    expect(within(section).getByText('$0.4234')).toBeInTheDocument()
    // The DAG itself is still on screen too (never blanked).
    expect(screen.getByRole('link', { name: 'DAN-90' })).toBeInTheDocument()
  })

  it('a first-tick ticketCosts failure renders the planning-only layout, not an error', async () => {
    vi.useFakeTimers()
    vi.mocked(ticketCosts).mockRejectedValue(new Error('down'))
    render(<WatchBuild promptId="fr1" />)
    await act(async () => {})

    expect(
      screen.queryByRole('region', { name: 'Cost breakdown' }),
    ).not.toBeInTheDocument()
    expect(screen.getByText(/Planning cost/)).toHaveTextContent('$0.1234')
    expect(screen.queryByText(/Live view stale/)).not.toBeInTheDocument()
  })
})

/* == 7. The my-requests model chip =========================================== */

const CSS = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'styles.css'),
  'utf8',
)

// Every declaration of every rule whose selector list contains `selector`,
// merged in source order, comments stripped.
function resolve(selector) {
  const decls = {}
  const rules = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(rules))) {
    if (!m[1].split(',').map((s) => s.trim()).includes(selector)) continue
    for (const part of m[2].split(';')) {
      const i = part.indexOf(':')
      if (i === -1) continue
      decls[part.slice(0, i).trim()] = part.slice(i + 1).trim()
    }
  }
  return decls
}

const modelled = {
  id: 'fr-1',
  status: 'building',
  model: SESSION_MODEL,
  createdAt: '2026-08-27T10:00:00.000Z',
  title: 'change_buttons_to_green',
  messages: [{ role: 'user', content: 'Make the buttons green' }],
  entranceCriteria: null,
  approvable: false,
  linearProjectUrl: null,
}

const legacySession = {
  ...modelled,
  id: 'fr-0',
  status: 'gathering',
  model: null,
  title: null,
  createdAt: '2026-08-26T09:00:00.000Z',
  messages: [{ role: 'user', content: 'CSV export please' }],
}

async function rows() {
  render(<MyRequests onOpen={() => {}} />)
  const region = await screen.findByRole('region', { name: 'My requests' })
  return within(region).getAllByRole('button')
}

describe('DAN-103 tester · the my-requests model chip — half one, the attribute', () => {
  it('carries the session model verbatim on rows that have one', async () => {
    vi.mocked(listFeatureRequests).mockResolvedValue([modelled])
    const [only] = await rows()
    expect(only).toHaveAttribute('data-model', SESSION_MODEL)
    // Verbatim: no re-casing, no truncation, no prefix stripping.
    expect(only.getAttribute('data-model')).toBe('claude-opus-5')
  })

  it('omits the attribute entirely for legacy, null, missing and blank models', async () => {
    const blanks = ['', '   ', '\t', '\n \n']
    vi.mocked(listFeatureRequests).mockResolvedValue([
      legacySession,
      { ...legacySession, id: 'fr-nokey', model: undefined, createdAt: '2026-08-25T09:00:00.000Z' },
      ...blanks.map((model, i) => ({
        ...legacySession,
        id: `fr-blank-${i}`,
        model,
        createdAt: `2026-08-2${i}T09:00:00.000Z`,
      })),
    ])
    for (const button of await rows()) {
      expect(button).not.toHaveAttribute('data-model')
      // Never an empty pill: the attribute is absent, not present-and-blank.
      expect(button.outerHTML).not.toContain('data-model')
    }
  })

  it('leaves the DAN-91 frozen row skeleton byte-identical, chip or no chip', async () => {
    vi.mocked(listFeatureRequests).mockResolvedValue([modelled, legacySession])
    const [withChip, without] = await rows()
    // Class lists differ only by the status modifier, so compare the shape
    // with that one status class normalised away.
    const shape = (el) =>
      skeleton(el).replace(/my-requests__status--\w+/g, 'my-requests__status--X')
    expect(shape(withChip)).toBe(shape(without))
    expect(shape(withChip)).toBe(
      'button.my-requests__row(' +
        'span.my-requests__preview,' +
        'span.my-requests__status.my-requests__status--X,' +
        'span.my-requests__date)',
    )
  })
})

describe('DAN-103 tester · the my-requests model chip — half two, the stylesheet', () => {
  it('turns the attribute into visible generated content', () => {
    const chip = resolve('.my-requests__row[data-model]::after')
    expect(chip.content).toBe('attr(data-model)')
    expect(chip.color).toBe('var(--color-muted)')
    expect(chip['border-radius']).toBeTruthy()
    expect(chip['white-space']).toBe('nowrap')
    // No `display: none`/`content: none` anywhere in the rule that would make
    // the chip a no-op while the attribute still passes half one.
    expect(chip.display).not.toBe('none')
    expect(chip.content).not.toBe('none')
  })

  it('is laid out as a real item: the row is a flex container and the chip is ordered into it', () => {
    // Generated content only lays out as a row item because the row itself is
    // a flex container — without this the `order` below would do nothing.
    expect(resolve('.my-requests__row').display).toBe('flex')
    const chipOrder = Number(resolve('.my-requests__row[data-model]::after').order)
    const statusOrder = Number(resolve('.my-requests__status').order)
    const dateOrder = Number(resolve('.my-requests__date').order)
    expect(chipOrder).toBeGreaterThan(0)
    expect(statusOrder).toBeGreaterThan(chipOrder)
    expect(dateOrder).toBeGreaterThan(statusOrder)
    // The label keeps the implicit order 0 that DAN-91 froze.
    expect(resolve('.my-requests__preview').order).toBeUndefined()
    expect(resolve('.my-requests__preview').flex).toBe('1')
  })

  it('scopes the chip to rows that have the attribute — the bare class grows no ::after', () => {
    expect(resolve('.my-requests__row::after').content).toBeUndefined()
    expect(resolve('.my-requests__row').content).toBeUndefined()
  })

  it('RECORDS THE GAP: the chip text is not in the DOM, so it is not selectable, findable or copyable', async () => {
    // This is the documented cost of the generated-content approach (DAN-104
    // promotes the chip to a real span). Asserting it keeps the trade-off
    // visible rather than silently accepted, and this test is the one that
    // must be deleted when DAN-104 lands.
    vi.mocked(listFeatureRequests).mockResolvedValue([modelled])
    const [only] = await rows()
    expect(only.textContent).not.toContain(SESSION_MODEL)
    expect(screen.queryByText(SESSION_MODEL)).not.toBeInTheDocument()
    // The two halves above are therefore evidence, not proof: nothing in this
    // environment renders the pseudo-element, so "the user sees the chip"
    // rests on the stylesheet rule being correct rather than on it being
    // observed. jsdom does not implement pseudo-element computed style at all
    // — the model never enters the accessibility tree or the text layer here,
    // which is exactly why no jsdom test can close this gap.
    expect(only.innerHTML).not.toContain(SESSION_MODEL)
    expect(document.body.textContent).not.toContain(SESSION_MODEL)
  })
})
