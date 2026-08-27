// DAN-71 tester verification. Independent of the developer's own
// FeatureRequestView.dan71.test.jsx. Locks the ticket's acceptance criteria:
//  - The composer is a multi-line <textarea> (rows=3) inside the composer
//    form. Plain Enter keeps its default (newline insertion — the handler
//    must NOT preventDefault and must NOT submit); Cmd+Enter and Ctrl+Enter
//    both submit (and DO preventDefault, so no stray newline lands in the
//    cleared draft); the Send button still submits. The ~8-row cap and
//    full-width are CSS (max-height / width on .chat-composer__textarea),
//    which per the repo rule tests never assert — verified by inspection.
//  - Multi-line content with embedded newlines reaches
//    sendFeatureRequestMessage VERBATIM — exact string asserted, \n intact —
//    on both the button path and the Cmd+Enter path, and renders in the
//    transcript with the newlines still in the text content.
//  - Cmd+Enter mid-flight is a no-op: the in-flight guard covers the
//    keyboard path, not just the disabled button. (The keydown is forced
//    programmatically because the disabled textarea would swallow it in a
//    real browser — belt and suspenders, same idea as DAN-67's forced
//    submit.)
//  - Enter with the Send button focused: the keydown handler lives on the
//    textarea only, so Enter on the button falls through to native submit
//    activation (jsdom does not simulate that activation; the test asserts
//    the handler does not interfere and that the activation's submit event
//    sends — form semantics stay coherent).
//  - DAN-53/54/66/67 survivals: composer + Send disabled in flight and
//    under QUOTA_EXHAUSTED (textarea disabled explicitly asserted), draft
//    cleared synchronously on optimistic send, failed rounds keep the
//    message with a retry that resends the same multi-line content
//    verbatim.
//  - The expectation hint ("…take a minute") renders near the composer and
//    disappears at the building hand-off (approved flow mocked end to end).
//
// api.js is fully mocked; WatchBuild is stubbed so the hand-off assertion
// does not drag DAN-55's polling into this suite.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { approveFeatureRequestPlan, sendFeatureRequestMessage, startFeatureRequest } from './api.js'
import FeatureRequestView from './FeatureRequestView.jsx'

vi.mock('./api.js', () => ({
  startFeatureRequest: vi.fn(),
  sendFeatureRequestMessage: vi.fn(),
  featureRequest: vi.fn(),
  // Resolves to nothing so the meter skips its state update and the suite
  // stays act()-quiet (same shape as the DAN-53/54/67 suites).
  myAiUsage: vi.fn(async () => undefined),
  approveFeatureRequestPlan: vi.fn(),
}))

vi.mock('./WatchBuild.jsx', () => ({
  default: ({ promptId }) => (
    <div data-testid="watch-build">watching build for {promptId}</div>
  ),
}))

// A distinctive id, so a hardcoded id in the component cannot pass the
// call-args assertions.
const STARTED_ID = 'fr-tester-71'

// The load-bearing string: embedded newlines, including a blank line. The
// component trims only the ends (draft.trim()), so every interior \n must
// survive to the API call byte for byte.
const MULTI_LINE =
  'As a user I want CSV export.\nColumns: id, name, created.\n\nAlso Excel, if cheap.'

function makeRequest(messages = [], extra = {}) {
  return {
    id: STARTED_ID,
    status: 'open',
    model: 'claude-opus-5',
    createdAt: '2026-08-27T00:00:00.000Z',
    messages,
    entranceCriteria: null,
    approvable: false,
    ...extra,
  }
}

function deferred() {
  let resolve_, reject_
  const promise = new Promise((res, rej) => {
    resolve_ = res
    reject_ = rej
  })
  return { promise, resolve: resolve_, reject: reject_ }
}

function quotaError() {
  const err = new Error('AI request quota exhausted')
  err.extensions = { code: 'QUOTA_EXHAUSTED' }
  return err
}

function composer() {
  return screen.getByLabelText('Message')
}

function sendButton() {
  return screen.getByRole('button', { name: 'Send' })
}

function setDraft(text) {
  fireEvent.change(composer(), { target: { value: text } })
}

function transcript() {
  return screen.getByRole('list', { name: 'Conversation' })
}

beforeEach(() => {
  vi.mocked(startFeatureRequest).mockReset()
  vi.mocked(sendFeatureRequestMessage).mockReset()
  vi.mocked(approveFeatureRequestPlan).mockReset()
  // jsdom has no scrollIntoView; the component calls it on transcript
  // appends.
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  delete Element.prototype.scrollIntoView
})

describe('DAN-71 tester · the composer is a multi-line textarea', () => {
  it('renders a <textarea> with a 3-row floor inside the composer form', () => {
    render(<FeatureRequestView onBack={() => {}} />)
    const field = composer()
    expect(field.tagName).toBe('TEXTAREA')
    expect(field).toHaveAttribute('rows', '3')
    expect(field.closest('form')).not.toBeNull()
    expect(field.closest('form')).toContainElement(sendButton())
  })

  it('plain Enter does not submit and keeps its default, so the newline insertion survives', () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    render(<FeatureRequestView onBack={() => {}} />)
    setDraft('line one')

    // fireEvent returns false when preventDefault was called — a prevented
    // Enter would kill the textarea's native newline insertion.
    const defaultKept = fireEvent.keyDown(composer(), { key: 'Enter' })
    expect(defaultKept).toBe(true)
    expect(startFeatureRequest).not.toHaveBeenCalled()
    expect(sendFeatureRequestMessage).not.toHaveBeenCalled()
    // The draft is untouched — nothing cleared it.
    expect(composer()).toHaveValue('line one')
  })

  it('Shift+Enter and Alt+Enter are not submit chords either', () => {
    render(<FeatureRequestView onBack={() => {}} />)
    setDraft('line one')
    fireEvent.keyDown(composer(), { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(composer(), { key: 'Enter', altKey: true })
    expect(startFeatureRequest).not.toHaveBeenCalled()
    expect(sendFeatureRequestMessage).not.toHaveBeenCalled()
  })
})

describe('DAN-71 tester · Cmd/Ctrl+Enter submits, Send still submits', () => {
  it('Cmd+Enter sends the multi-line draft VERBATIM (embedded \\n intact) and prevents the keydown default', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
      makeRequest([{ role: 'user', content: MULTI_LINE }]),
    )
    render(<FeatureRequestView onBack={() => {}} />)
    setDraft(MULTI_LINE)

    const defaultKept = fireEvent.keyDown(composer(), {
      key: 'Enter',
      metaKey: true,
    })
    // A submit chord must preventDefault, or the newline default would land
    // in the just-cleared draft.
    expect(defaultKept).toBe(false)
    // Cleared synchronously — the optimistic-clear behavior on the keyboard
    // path.
    expect(composer()).toHaveValue('')

    await waitFor(() =>
      expect(sendFeatureRequestMessage).toHaveBeenCalledTimes(1),
    )
    expect(sendFeatureRequestMessage).toHaveBeenCalledWith(
      STARTED_ID,
      MULTI_LINE,
    )
  })

  it('Ctrl+Enter submits identically (the non-mac chord)', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
      makeRequest([{ role: 'user', content: 'ctrl path' }]),
    )
    render(<FeatureRequestView onBack={() => {}} />)
    setDraft('ctrl path')

    fireEvent.keyDown(composer(), { key: 'Enter', ctrlKey: true })

    await waitFor(() =>
      expect(sendFeatureRequestMessage).toHaveBeenCalledWith(
        STARTED_ID,
        'ctrl path',
      ),
    )
  })

  it('the Send button still submits, and the multi-line content reaches the API verbatim on that path too', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    const d = deferred()
    vi.mocked(sendFeatureRequestMessage).mockReturnValue(d.promise)
    render(<FeatureRequestView onBack={() => {}} />)
    setDraft(MULTI_LINE)
    fireEvent.click(sendButton())

    // The optimistic transcript row carries the newlines in its text content.
    await waitFor(() => expect(transcript()).toBeInTheDocument())
    const rows = within(transcript()).getAllByRole('listitem')
    const body = rows[0].querySelector('.chat-message__content')
    expect(body.textContent).toBe(MULTI_LINE)

    d.resolve(makeRequest([{ role: 'user', content: MULTI_LINE }]))
    await waitFor(() =>
      expect(sendFeatureRequestMessage).toHaveBeenCalledTimes(1),
    )
    expect(sendFeatureRequestMessage).toHaveBeenCalledWith(
      STARTED_ID,
      MULTI_LINE,
    )
  })

  it('Cmd+Enter on an empty or whitespace-only draft is a no-op', () => {
    render(<FeatureRequestView onBack={() => {}} />)
    fireEvent.keyDown(composer(), { key: 'Enter', metaKey: true })
    setDraft('  \n  \n ')
    fireEvent.keyDown(composer(), { key: 'Enter', metaKey: true })
    expect(startFeatureRequest).not.toHaveBeenCalled()
    expect(sendFeatureRequestMessage).not.toHaveBeenCalled()
  })
})

describe('DAN-71 tester · form semantics: Enter with the Send button focused', () => {
  it('the keydown handler does not interfere with the button, and native activation submits through the same single path', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
      makeRequest([{ role: 'user', content: 'button focus path' }]),
    )
    render(<FeatureRequestView onBack={() => {}} />)
    setDraft('button focus path')

    const button = sendButton()
    expect(button).toHaveAttribute('type', 'submit')
    button.focus()
    // Enter on a focused submit button: no component handler intercepts it
    // (the chord handler is on the textarea only), so the browser's native
    // activation fires the form's submit. jsdom does not simulate the
    // activation itself, so the two halves are asserted separately: the
    // keydown passes through untouched…
    const defaultKept = fireEvent.keyDown(button, { key: 'Enter' })
    expect(defaultKept).toBe(true)
    expect(sendFeatureRequestMessage).not.toHaveBeenCalled()
    // …and the activation's submit event goes through handleSubmit.
    fireEvent.submit(button.closest('form'))
    await waitFor(() =>
      expect(sendFeatureRequestMessage).toHaveBeenCalledWith(
        STARTED_ID,
        'button focus path',
      ),
    )
    expect(sendFeatureRequestMessage).toHaveBeenCalledTimes(1)
  })
})

describe('DAN-71 tester · DAN-53/54/66/67 behaviors survive the textarea', () => {
  it('mid-flight: textarea and Send are disabled, and a forced Cmd+Enter is a no-op (the guard covers the keyboard path)', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    const d = deferred()
    vi.mocked(sendFeatureRequestMessage).mockReturnValue(d.promise)
    render(<FeatureRequestView onBack={() => {}} />)
    setDraft('first message')
    fireEvent.click(sendButton())

    await waitFor(() => expect(composer()).toBeDisabled())
    expect(sendButton()).toBeDisabled()

    // Force draft content and the chord past the disabled attribute — in a
    // real browser the disabled textarea swallows both, but the submit guard
    // must hold even if an event sneaks through.
    setDraft('smuggled second message')
    fireEvent.keyDown(composer(), { key: 'Enter', metaKey: true })
    expect(sendFeatureRequestMessage).toHaveBeenCalledTimes(1)
    expect(startFeatureRequest).toHaveBeenCalledTimes(1)

    d.resolve(makeRequest([{ role: 'user', content: 'first message' }]))
    await waitFor(() => expect(composer()).toBeEnabled())
    expect(sendButton()).toBeEnabled()
    expect(sendFeatureRequestMessage).toHaveBeenCalledTimes(1)
  })

  it('QUOTA_EXHAUSTED disables the textarea and Send, shows the friendly panel, and the retry control disables with them', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockRejectedValue(quotaError())
    render(<FeatureRequestView onBack={() => {}} />)
    setDraft('over quota')
    fireEvent.keyDown(composer(), { key: 'Enter', metaKey: true })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/out of AI quota/i)
    expect(composer()).toBeDisabled()
    expect(composer().tagName).toBe('TEXTAREA')
    expect(sendButton()).toBeDisabled()
    const item = within(transcript()).getByRole('listitem')
    expect(item).toHaveTextContent('not delivered')
    expect(within(item).getByRole('button', { name: 'retry' })).toBeDisabled()
  })

  it('a failed round keeps the multi-line message with a retry that resends the same content verbatim', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockRejectedValueOnce(
      new Error('gateway timeout'),
    )
    render(<FeatureRequestView onBack={() => {}} />)
    setDraft(MULTI_LINE)
    fireEvent.click(sendButton())

    await screen.findByRole('alert')
    const item = within(transcript()).getByRole('listitem')
    expect(item.querySelector('.chat-message__content').textContent).toBe(
      MULTI_LINE,
    )
    expect(item).toHaveTextContent('not delivered')
    expect(composer()).toBeEnabled()

    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
      makeRequest([{ role: 'user', content: MULTI_LINE }]),
    )
    fireEvent.click(within(item).getByRole('button', { name: 'retry' }))
    await waitFor(() =>
      expect(sendFeatureRequestMessage).toHaveBeenCalledTimes(2),
    )
    expect(sendFeatureRequestMessage).toHaveBeenNthCalledWith(
      2,
      STARTED_ID,
      MULTI_LINE,
    )
    expect(startFeatureRequest).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(screen.queryByText('not delivered')).not.toBeInTheDocument(),
    )
  })
})

describe('DAN-71 tester · the expectation hint', () => {
  it('renders near the composer from the start', () => {
    render(<FeatureRequestView onBack={() => {}} />)
    const hint = screen.getByText(/take a minute/i)
    expect(hint).toBeInTheDocument()
    // Near the composer: the hint immediately follows the composer form.
    const form = composer().closest('form')
    expect(hint.previousElementSibling).toBe(form)
  })

  it('disappears at the building hand-off (approved flow), along with the composer', async () => {
    vi.mocked(startFeatureRequest).mockResolvedValue(makeRequest())
    vi.mocked(sendFeatureRequestMessage).mockResolvedValue(
      makeRequest([{ role: 'user', content: 'ship it' }], {
        approvable: true,
        entranceCriteria: {
          notTooBig: { pass: true, reason: 'small' },
          notAmbiguous: { pass: true, reason: 'clear' },
          noBlockedDependencies: { pass: true, reason: 'free' },
        },
      }),
    )
    vi.mocked(approveFeatureRequestPlan).mockResolvedValue(
      makeRequest([{ role: 'user', content: 'ship it' }], {
        status: 'building',
      }),
    )
    render(<FeatureRequestView onBack={() => {}} />)
    setDraft('ship it')
    fireEvent.keyDown(composer(), { key: 'Enter', metaKey: true })

    const approve = await screen.findByRole('button', {
      name: 'Approve plan',
    })
    await waitFor(() => expect(approve).toBeEnabled())
    fireEvent.click(approve)

    await waitFor(() =>
      expect(screen.getByTestId('watch-build')).toBeInTheDocument(),
    )
    expect(approveFeatureRequestPlan).toHaveBeenCalledWith(STARTED_ID)
    // The hand-off replaces the composer AND its hint — no stale "take a
    // minute" note under the build view.
    expect(screen.queryByText(/take a minute/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Send' }),
    ).not.toBeInTheDocument()
  })
})
