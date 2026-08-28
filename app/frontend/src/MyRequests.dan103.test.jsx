import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { listFeatureRequests } from './api.js'
import MyRequests, { modelChipOf } from './MyRequests.jsx'

// DAN-103: the my-requests row shows the session's model as a small muted
// chip; a legacy session without one simply omits the chip.
//
// The chip is generated content: the DAN-91 tester suite freezes the row
// button's exact tag+class skeleton, so the model rides a data-model attribute
// and styles.css renders it via .my-requests__row[data-model]::after. jsdom
// does not render pseudo-elements, so this suite asserts the two halves that
// together produce the visible chip: the attribute on the row (mocked api.js,
// same idiom as MyRequests.dan91.test.jsx), and the stylesheet rule that turns
// the attribute into on-screen text (read and resolved from styles.css, the
// dan91.tester.test.jsx Criterion-4 idiom).
vi.mock('./api.js', () => ({
  listFeatureRequests: vi.fn(),
}))

// Newest: a normal session with a model.
const withModel = {
  id: 'fr-model',
  status: 'building',
  model: 'claude-opus-5',
  createdAt: '2026-08-27T10:00:00.000Z',
  title: 'change_buttons_to_green',
  messages: [{ role: 'user', content: 'Make the buttons green' }],
  entranceCriteria: null,
  approvable: false,
  linearProjectUrl: null,
}

// Older: a legacy session with no model at all.
const legacy = {
  id: 'fr-legacy',
  status: 'gathering',
  model: null,
  createdAt: '2026-08-26T09:00:00.000Z',
  title: null,
  messages: [{ role: 'user', content: 'CSV export for the records table' }],
  entranceCriteria: null,
  approvable: false,
  linearProjectUrl: null,
}

// Oldest: a blank model is treated as absent, never rendered as an empty pill.
const blankModel = {
  ...legacy,
  id: 'fr-blank',
  model: '   ',
  createdAt: '2026-08-25T09:00:00.000Z',
  messages: [{ role: 'user', content: 'Dark mode please' }],
}

beforeEach(() => {
  vi.mocked(listFeatureRequests).mockReset()
  vi.mocked(listFeatureRequests).mockResolvedValue([
    legacy,
    withModel,
    blankModel,
  ])
})

describe('DAN-103 modelChipOf', () => {
  it('returns the model verbatim when present', () => {
    expect(modelChipOf(withModel)).toBe('claude-opus-5')
  })

  it('returns null for a missing, null, or blank model', () => {
    expect(modelChipOf(legacy)).toBeNull()
    expect(modelChipOf(blankModel)).toBeNull()
    expect(modelChipOf({})).toBeNull()
    expect(modelChipOf({ model: '' })).toBeNull()
    expect(modelChipOf({ model: '\t\n' })).toBeNull()
  })
})

describe('DAN-103 my-requests model chip', () => {
  it('puts the model on rows that have one and no attribute at all on rows that do not', async () => {
    render(<MyRequests onOpen={() => {}} />)

    const region = await screen.findByRole('region', { name: 'My requests' })
    const rows = within(region).getAllByRole('button')
    expect(rows).toHaveLength(3)

    // Newest first: the modeled session carries its model verbatim.
    expect(rows[0]).toHaveAttribute('data-model', 'claude-opus-5')
    expect(rows[0]).toHaveTextContent('change_buttons_to_green')

    // The legacy session renders everything else and no chip — without the
    // attribute the [data-model]::after rule cannot produce one.
    expect(rows[1]).toHaveTextContent('CSV export for the records table')
    expect(rows[1]).not.toHaveAttribute('data-model')

    // A whitespace-only model is absent, not an empty pill.
    expect(rows[2]).toHaveTextContent('Dark mode please')
    expect(rows[2]).not.toHaveAttribute('data-model')
  })

  it('keeps the row DOM skeleton exactly DAN-91 frozen shape, chip or no chip', async () => {
    render(<MyRequests onOpen={() => {}} />)
    const region = await screen.findByRole('region', { name: 'My requests' })

    for (const row of within(region).getAllByRole('button')) {
      // The same reduction the DAN-91 tester applies: tag + sorted classes +
      // children, text stripped. The chip must not have changed it.
      const skeleton = (el) => {
        const classes = [...el.classList].sort().join('.')
        const kids = [...el.children].map(skeleton).join(',')
        return `${el.tagName.toLowerCase()}${classes ? `.${classes}` : ''}${
          kids ? `(${kids})` : ''
        }`
      }
      expect(skeleton(row)).toBe(
        'button.my-requests__row(' +
          'span.my-requests__preview,' +
          `span.my-requests__status.my-requests__status--${
            row.textContent.includes('building') ? 'building' : 'gathering'
          },` +
          'span.my-requests__date)',
      )
    }
  })
})

/* -- The stylesheet half: the attribute becomes a visible pill --------------- */

const CSS = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'styles.css'),
  'utf8',
)

// Declarations of the one rule whose selector is exactly `selector`, comments
// stripped (the dan91.tester Criterion-4 idiom, narrowed to a single selector).
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

describe('DAN-103 chip stylesheet rule', () => {
  it('renders the data-model attribute as generated content, styled as a muted pill', () => {
    const chip = resolve('.my-requests__row[data-model]::after')

    // The content IS the attribute — the chip shows the model verbatim, and
    // only when the attribute exists.
    expect(chip.content).toBe('attr(data-model)')
    // Pill treatment: small, muted, bordered, one line.
    expect(chip['font-size']).toBeTruthy()
    expect(chip.color).toBe('var(--color-muted)')
    expect(chip.border).toContain('var(--color-border)')
    expect(chip['border-radius']).toBeTruthy()
    expect(chip['white-space']).toBe('nowrap')
    // It slots between the label (order 0) and the status word in the row's
    // flex order without touching the DOM.
    expect(Number(chip.order)).toBeGreaterThan(0)
    expect(Number(resolve('.my-requests__status').order)).toBeGreaterThan(
      Number(chip.order),
    )
  })

  it('leaves the frozen label declarations alone — the preview still takes the slack', () => {
    const label = resolve('.my-requests__preview')
    expect(label.flex).toBe('1')
    expect(label.order).toBeUndefined()
  })
})
