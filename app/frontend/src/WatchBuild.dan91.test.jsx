import { render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { featureRequestCost, featureRequestProgress } from './api.js'
import WatchBuild from './WatchBuild.jsx'

// DAN-91: the building-view header shows the request's generated title —
// DAN-90's snake_case slug — beside the "View in Linear" link, and shows
// nothing at all when the field is null. Mocked api.js, accessible-text
// assertions, same idiom as WatchBuild.dan81.test.jsx.
vi.mock('./api.js', () => ({
  featureRequestProgress: vi.fn(),
  featureRequestCost: vi.fn(),
  featureRequestActivity: vi.fn(),
}))

const TITLE = 'change_buttons_to_green'
const LONG_TITLE =
  'add_a_nightly_usage_report_emailed_to_every_admin_with_a_per_team_breakdown_and_a_csv_attachment'
const LINEAR_URL = 'https://linear.app/daniel-perez/project/buttons-1a2b3c'

const oneInFlight = [
  {
    issueId: 'iss-1',
    identifier: 'DAN-90',
    title: 'Backend contract',
    state: 'IN_PROGRESS',
    issueUrl: 'https://linear.app/daniel-perez/issue/DAN-90',
    prUrl: null,
    blockedBy: [],
  },
]

function header() {
  return document.querySelector('.watch-build__header')
}

beforeEach(() => {
  vi.mocked(featureRequestProgress).mockReset()
  vi.mocked(featureRequestCost).mockReset()
  vi.mocked(featureRequestProgress).mockResolvedValue(oneInFlight)
  vi.mocked(featureRequestCost).mockResolvedValue({
    calls: 7,
    tokensIn: 5120,
    tokensOut: 2048,
    costUsd: 0.1234,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('DAN-91 generated title in the build header', () => {
  it('shows the title beside the View in Linear link', async () => {
    render(
      <WatchBuild
        promptId="fr1"
        linearProjectUrl={LINEAR_URL}
        title={TITLE}
      />,
    )

    await screen.findByRole('link', { name: 'View in Linear' })
    expect(within(header()).getByText(TITLE)).toBeInTheDocument()
  })

  it('renders no title when the field is null', async () => {
    render(
      <WatchBuild promptId="fr1" linearProjectUrl={LINEAR_URL} title={null} />,
    )

    // The rest of the header is intact — only the title is absent.
    await screen.findByRole('link', { name: 'View in Linear' })
    expect(
      header().querySelector('.watch-build__title'),
    ).not.toBeInTheDocument()
    expect(screen.getByText(/Planning cost/)).toBeInTheDocument()
  })

  it('defaults to no title when the prop is omitted entirely', async () => {
    render(<WatchBuild promptId="fr1" linearProjectUrl={LINEAR_URL} />)

    await screen.findByRole('link', { name: 'DAN-90' })
    expect(
      header().querySelector('.watch-build__title'),
    ).not.toBeInTheDocument()
  })

  it('treats a blank title as absent', async () => {
    render(
      <WatchBuild promptId="fr1" linearProjectUrl={LINEAR_URL} title="   " />,
    )

    await screen.findByRole('link', { name: 'DAN-90' })
    expect(
      header().querySelector('.watch-build__title'),
    ).not.toBeInTheDocument()
  })

  it('prints the slug verbatim and never truncates it in JS', async () => {
    render(
      <WatchBuild
        promptId="fr1"
        linearProjectUrl={LINEAR_URL}
        title={LONG_TITLE}
      />,
    )

    await screen.findByRole('link', { name: 'DAN-90' })
    const el = header().querySelector('.watch-build__title')
    // Exact text: no case change, no underscore rewriting, no ellipsis — the
    // clipping is the stylesheet's job.
    expect(el.textContent).toBe(LONG_TITLE)
  })

  it('shows the title even when there is no Linear link', async () => {
    render(<WatchBuild promptId="fr1" linearProjectUrl={null} title={TITLE} />)

    await screen.findByRole('link', { name: 'DAN-90' })
    expect(within(header()).getByText(TITLE)).toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: 'View in Linear' }),
    ).not.toBeInTheDocument()
  })
})
