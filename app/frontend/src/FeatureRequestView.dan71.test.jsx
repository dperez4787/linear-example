import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { sendFeatureRequestMessage, startFeatureRequest } from './api.js'
import FeatureRequestView from './FeatureRequestView.jsx'

// DAN-71: the composer is a multi-line textarea — Enter stays a newline,
// Cmd/Ctrl+Enter submits, the Send button still submits — and a hint under
// the composer sets the expectation that replies take up to a minute. Same
// mocked-api harness as the other FeatureRequestView suites.
vi.mock('./api.js', () => ({
  startFeatureRequest: vi.fn(),
  sendFeatureRequestMessage: vi.fn(),
  featureRequest: vi.fn(),
  myAiUsage: vi.fn(async () => undefined),
  approveFeatureRequestPlan: vi.fn(),
  // WatchBuild (mounted at the building hand-off below) polls this; a
  // never-resolving promise keeps it in its loading state for the assertion.
  featureRequestProgress: vi.fn(() => new Promise(() => {})),
}))

function makeRequest(messages = [], overrides = {}) {
  return {
    id: 'fr1',
    status: 'open',
    model: 'claude-opus-5',
    createdAt: '2026-08-26T00:00:00.000Z',
    messages,
    ...overrides,
  }
}

const firstExchange = [
  { role: 'user', content: 'Please add CSV export' },
  { role: 'product-owner', content: 'I will slice this into a ticket' },
]

beforeEach(() => {
  vi.mocked(startFeatureRequest).mockReset()
  vi.mocked(sendFeatureRequestMessage).mockReset()
})

function composer() {
  return screen.getByLabelText('Message')
}

describe('DAN-71 multi-line composer', () => {
  it('renders the composer as a 3-row textarea', () => {
    render(<FeatureRequestView onBack={() => {}} />)

    const field = composer()
    expect(field.tagName).toBe('TEXTAREA')
    expect(field).toHaveAttribute('rows', '3')
  })

  it('holds a multi-line draft and sends it verbatim, newlines included', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
      makeRequest(firstExchange),
    )
    render(<FeatureRequestView onBack={() => {}} />)

    const draft = 'Line one\nLine two\nLine three'
    fireEvent.change(composer(), { target: { value: draft } })
    expect(composer()).toHaveValue(draft)

    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(sendFeatureRequestMessage).toHaveBeenCalledWith('fr1', draft),
    )
  })

  it('plain Enter does not submit', () => {
    render(<FeatureRequestView onBack={() => {}} />)

    fireEvent.change(composer(), { target: { value: 'First line' } })
    fireEvent.keyDown(composer(), { key: 'Enter' })

    // No round started: Enter's default (a newline in a textarea) is left
    // alone, so nothing reached the API and the draft is still in the box.
    expect(startFeatureRequest).not.toHaveBeenCalled()
    expect(sendFeatureRequestMessage).not.toHaveBeenCalled()
    expect(composer()).toHaveValue('First line')
  })

  it('Cmd+Enter submits the draft', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
      makeRequest(firstExchange),
    )
    render(<FeatureRequestView onBack={() => {}} />)

    fireEvent.change(composer(), { target: { value: 'Ship it' } })
    fireEvent.keyDown(composer(), { key: 'Enter', metaKey: true })

    await waitFor(() =>
      expect(sendFeatureRequestMessage).toHaveBeenCalledWith('fr1', 'Ship it'),
    )
    // Optimistic clear (DAN-67) fires from the keyboard path too.
    expect(composer()).toHaveValue('')
  })

  it('Ctrl+Enter submits the draft', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
      makeRequest(firstExchange),
    )
    render(<FeatureRequestView onBack={() => {}} />)

    fireEvent.change(composer(), { target: { value: 'Ship it' } })
    fireEvent.keyDown(composer(), { key: 'Enter', ctrlKey: true })

    await waitFor(() =>
      expect(sendFeatureRequestMessage).toHaveBeenCalledWith('fr1', 'Ship it'),
    )
  })

  it('Cmd+Enter on an empty or whitespace-only draft sends nothing', () => {
    render(<FeatureRequestView onBack={() => {}} />)

    fireEvent.keyDown(composer(), { key: 'Enter', metaKey: true })
    fireEvent.change(composer(), { target: { value: '   \n  ' } })
    fireEvent.keyDown(composer(), { key: 'Enter', metaKey: true })

    expect(startFeatureRequest).not.toHaveBeenCalled()
    expect(sendFeatureRequestMessage).not.toHaveBeenCalled()
  })
})

describe('DAN-71 expectation hint', () => {
  it('shows the reply-time hint next to the composer', () => {
    render(<FeatureRequestView onBack={() => {}} />)

    expect(
      screen.getByText('The team reads and replies — this can take a minute.'),
    ).toBeInTheDocument()
  })

  it('the hint leaves with the composer at the building hand-off', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
      makeRequest(firstExchange, { status: 'building' }),
    )
    render(<FeatureRequestView onBack={() => {}} />)

    fireEvent.change(composer(), { target: { value: 'Please add CSV export' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() =>
      expect(screen.queryByLabelText('Message')).not.toBeInTheDocument(),
    )
    expect(
      screen.queryByText('The team reads and replies — this can take a minute.'),
    ).not.toBeInTheDocument()
  })
})
