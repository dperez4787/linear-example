import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { listFeatureRequests } from './api.js'
import MyRequests, { PREVIEW_MAX_CHARS, rowLabelOf } from './MyRequests.jsx'

// DAN-91: the my-requests row leads with the request's generated title —
// DAN-90's snake_case slug — and falls back to DAN-74's truncated first-message
// preview when the field is null (a legacy session, or one not yet approved).
// Mocked api.js, accessible-text assertions, same idiom as the DAN-53..84
// suites. The list fetches for itself, so rendering MyRequests directly is
// enough; FeatureRequestView.dan74.test.jsx still covers it in situ.
vi.mock('./api.js', () => ({
  listFeatureRequests: vi.fn(),
}))

const TITLE = 'change_buttons_to_green'
const LONG_TITLE =
  'add_a_nightly_usage_report_emailed_to_every_admin_with_a_per_team_breakdown_and_a_csv_attachment'
const LONG_FIRST_MESSAGE =
  'Nightly usage report emailed to admins, with a per-team breakdown and a CSV attachment for the finance folks'

// Titled session (newer): approved, so DAN-90 has given it a slug.
const titled = {
  id: 'fr-titled',
  status: 'building',
  model: 'claude-opus-5',
  createdAt: '2026-08-27T10:00:00.000Z',
  title: TITLE,
  messages: [
    { role: 'user', content: 'Make the primary buttons green instead of blue' },
    { role: 'product-owner', content: 'Filed as tickets.' },
  ],
  entranceCriteria: null,
  approvable: false,
  linearProjectUrl: 'https://linear.app/daniel-perez/project/buttons',
}

// Untitled session (older): still gathering, so title is null and the row keeps
// the DAN-74 preview.
const untitled = {
  id: 'fr-untitled',
  status: 'gathering',
  model: 'gpt-5.6-terra',
  createdAt: '2026-08-26T09:00:00.000Z',
  title: null,
  messages: [
    { role: 'user', content: LONG_FIRST_MESSAGE },
    { role: 'product-owner', content: 'Which columns?' },
  ],
  entranceCriteria: null,
  approvable: false,
  linearProjectUrl: null,
}

function list() {
  return screen.getByRole('region', { name: 'My requests' })
}

beforeEach(() => {
  vi.mocked(listFeatureRequests).mockReset()
  vi.mocked(listFeatureRequests).mockResolvedValue([untitled, titled])
})

describe('DAN-91 my-requests row label', () => {
  it('shows the generated title when present and the preview when null — same row shape either way', async () => {
    render(<MyRequests onOpen={() => {}} />)

    const rows = await within(list()).findAllByRole('button')
    expect(rows).toHaveLength(2)

    // Newest first (DAN-74 ordering is untouched): the titled session leads
    // with its slug, not with its first message.
    expect(rows[0]).toHaveTextContent(TITLE)
    expect(rows[0]).not.toHaveTextContent(
      'Make the primary buttons green instead of blue',
    )

    // The untitled session still shows the truncated first-message preview.
    const truncated = `${LONG_FIRST_MESSAGE.slice(0, PREVIEW_MAX_CHARS - 1)}…`
    expect(rows[1]).toHaveTextContent(truncated)

    // Layout unchanged either way: both rows carry label + status + date, in
    // the same three spans.
    for (const row of rows) {
      expect(row.querySelectorAll('.my-requests__preview')).toHaveLength(1)
    }
    expect(rows[0]).toHaveTextContent('building')
    expect(rows[0]).toHaveTextContent('Aug 27, 2026')
    expect(rows[1]).toHaveTextContent('gathering')
    expect(rows[1]).toHaveTextContent('Aug 26, 2026')
  })

  it('renders the slug verbatim — no case changes and no underscore rewriting', async () => {
    render(<MyRequests onOpen={() => {}} />)

    const row = (await within(list()).findAllByRole('button'))[0]
    const label = row.querySelector('.my-requests__preview')
    expect(label).toHaveTextContent(TITLE)
    // Exact text, not a reformatted variant.
    expect(label.textContent).toBe(TITLE)
  })

  it('does not truncate a long slug in JS — the row clips it in CSS instead', async () => {
    vi.mocked(listFeatureRequests).mockResolvedValue([
      { ...titled, title: LONG_TITLE },
    ])
    render(<MyRequests onOpen={() => {}} />)

    const row = (await within(list()).findAllByRole('button'))[0]
    const label = row.querySelector('.my-requests__preview')
    expect(label.textContent).toBe(LONG_TITLE)
    expect(label.textContent).not.toContain('…')
  })

  it('treats a blank title as absent and falls back to the preview', async () => {
    vi.mocked(listFeatureRequests).mockResolvedValue([
      { ...untitled, title: '   ' },
    ])
    render(<MyRequests onOpen={() => {}} />)

    const row = (await within(list()).findAllByRole('button'))[0]
    const truncated = `${LONG_FIRST_MESSAGE.slice(0, PREVIEW_MAX_CHARS - 1)}…`
    expect(row).toHaveTextContent(truncated)
  })
})

describe('DAN-91 rowLabelOf', () => {
  it('prefers the title, falls back to the preview, and tolerates a missing field', () => {
    expect(rowLabelOf(titled)).toBe(TITLE)
    expect(rowLabelOf(untitled)).toBe(
      `${LONG_FIRST_MESSAGE.slice(0, PREVIEW_MAX_CHARS - 1)}…`,
    )
    // Legacy shape from before DAN-90: no `title` key at all.
    const { title: _title, ...legacy } = titled
    expect(rowLabelOf(legacy)).toBe(
      'Make the primary buttons green instead of blue',
    )
  })
})
