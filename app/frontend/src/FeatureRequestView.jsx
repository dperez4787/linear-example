import { useEffect, useRef, useState } from 'react'

import {
  approveFeatureRequestPlan,
  featureRequest,
  myAiUsage,
  sendFeatureRequestMessage,
  startFeatureRequest,
} from './api.js'
import { renderMarkdown } from './markdown.jsx'
import MyRequests from './MyRequests.jsx'
import WatchBuild from './WatchBuild.jsx'

// The "Request a feature" chat pane (DAN-53), extended by DAN-54 with the model
// picker, the entrance-criteria checklist, the quota meter, the friendly
// quota-exhausted state, and the Approve button. Rendered by App in place of
// the records view — App owns which view is showing (state-based switching, no
// router); this component owns the conversation.
//
// The canonical transcript is whatever the server last returned: submitting a
// message resolves to the updated FeatureRequest whose messages array already
// contains the user's message plus the role-labeled replies. DAN-67 layers a
// client-side pending list on top of that: on Send the user's message renders
// immediately (the round takes four model calls, 30-60s — a bare spinner reads
// as the app being broken), the composer clears at once, and an animated
// "product-owner is thinking…" status holds the reply's place. When the server
// transcript arrives it already contains the delivered message, so the pending
// copy is dropped in the same update — the canonical row replaces the
// optimistic one with no duplicate. DAN-53's original worry (a chat message
// silently vanishing on failure would read as the app eating input) is met the
// chat-grade way instead of the composer-keeps-the-draft way: a failed
// message *stays* in the transcript, marked "not delivered" with a retry
// control that resends the same content. The checklist and the Approve gate
// are unchanged: pure renderings of the last FeatureRequest the server
// returned (entranceCriteria / approvable), updating after every exchange with
// no extra fetch.
//
// DAN-71 turns the composer into a multi-line textarea (3 rows, autosizing to
// ~8 before scrolling): Enter inserts a newline, Cmd/Ctrl+Enter submits, and
// the Send button still submits. A hint under the composer sets the
// expectation that replies take up to a minute.
//
// The first submit lazily starts the conversation: startFeatureRequest(model),
// then sendFeatureRequestMessage with the new id. The started request is stored
// before the send, so a failed first send retries against the same conversation
// instead of creating a second one.

// The picker's rows (DAN-54, roster completed by DAN-66). All four models are
// now live through the gateway and accepted by the backend (DAN-65), so the
// former "coming soon" three graduated to selectable radios. The coding tools
// still render as display-only entries with no input at all, so they can never
// be selected whether or not the picker is locked.
const SELECTABLE_MODELS = [
  'claude-opus-5',
  'gpt-5.6-terra',
  'gemini-3.6-flash',
  'gpt-oss-120b',
]
const DISPLAY_ONLY_TOOLS = ['Copilot', 'Cursor', 'Amp']

// The session statuses that mean "approved, tickets filed" — the ones that hand
// this view off to the build DAG and hide the Approve button. "building" is
// work in flight; DAN-94's "shipped" is the terminal state a session reaches
// once every filed ticket is done. A shipped session must still open its DAG:
// the graph is the record of what was built, and WatchBuild already renders it
// complete (its "Build complete — every ticket is done." line, and no further
// polling). Hiding Approve for both is not cosmetic either — the backend
// refuses approval outside "gathering", so the button must never promise it.
// Exported so the tests assert the vocabulary rather than re-listing it.
export const BUILD_HANDOFF_STATUSES = ['building', 'shipped']

// The three entrance gates, in checklist order. Keys match the agreed
// FeatureRequest.entranceCriteria shape (DAN-50); labels are the gate names
// from the ticket. entranceCriteria is null until the first evaluation, so each
// row renders "Not yet evaluated" until the server has judged the request.
const GATES = [
  { key: 'notTooBig', label: 'not-too-big' },
  { key: 'notAmbiguous', label: 'not-ambiguous' },
  { key: 'noBlockedDependencies', label: 'no-blocked-dependencies' },
]

// The quota-exhausted signal, exactly as api.js surfaces it: gql() attaches the
// GraphQL error's extensions to the thrown Error, and the backend's error
// mapper emits code QUOTA_EXHAUSTED for the AI gateway's 429.
function isQuotaExhausted(err) {
  return err?.extensions?.code === 'QUOTA_EXHAUSTED'
}

// -- DAN-79: markdown agent replies with a typewriter reveal -----------------
//
// Agent replies are markdown; renderMarkdown (src/markdown.jsx) turns them
// into React elements — assistant bubbles only, user bubbles stay plain text.
//
// Reveal approach (the ticket left the choice open): slice the RAW text and
// re-parse the slice each tick, rather than revealing block-by-block. Replies
// are a few KB at most, the parser is a single line scan, and slicing raw
// text means the reveal is character-accurate — a half-arrived code fence
// renders as a growing code block (the parser treats an unclosed fence as
// running to end-of-input) instead of the whole block popping in at once.
//
// ~1000 chars/s as 25 chars every 25ms — a fixed chars-per-tick interval is
// deterministic under fake timers, unlike wall-clock math.
const REVEAL_TICK_MS = 25
const REVEAL_CHARS_PER_TICK = 25

// The reveal animates only when the environment can confirm the user has NOT
// asked for reduced motion. Where matchMedia is missing (jsdom — the same
// progressive-enhancement stance as the optional scrollIntoView call above),
// messages render complete instantly; tests that exercise the typewriter stub
// window.matchMedia. Every real browser has matchMedia, so the reveal always
// runs in production unless the user opted out.
function prefersReducedMotion() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return true
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

// One assistant bubble. `animate` is latched at mount (a message that starts
// complete never starts typing later); while typing, clicking the bubble
// completes it instantly. onDone fires once the full text is shown — the
// parent records the message as revealed so re-renders never replay it.
function AssistantMessage({ role, content, animate, onDone }) {
  const [revealCount, setRevealCount] = useState(
    animate ? 0 : content.length,
  )
  const done = revealCount >= content.length

  useEffect(() => {
    if (done) return undefined
    const id = setInterval(() => {
      setRevealCount((count) =>
        Math.min(content.length, count + REVEAL_CHARS_PER_TICK),
      )
    }, REVEAL_TICK_MS)
    return () => clearInterval(id)
  }, [done, content.length])

  useEffect(() => {
    if (done) onDone()
  }, [done, onDone])

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <li
      className={`chat-message chat-message--${role}${
        done ? '' : ' chat-message--revealing'
      }`}
      onClick={done ? undefined : () => setRevealCount(content.length)}
    >
      <span className="chat-message__role">{role}</span>
      <div className="chat-message__content chat-message__content--markdown">
        {renderMarkdown(content.slice(0, revealCount))}
      </div>
    </li>
  )
}

// DAN-82 adds two routing props, both optional so every pre-routing caller
// (and test) keeps working unchanged:
//  - `requestId`: the `/requests/:id` deep link's id. When set, the view loads
//    that session (fetch-and-adopt, below) instead of offering a fresh start.
//  - `onNavigate(path)`: the App-owned pushState navigation. The view calls it
//    at exactly the moments a session acquires a URL of its own — opening a
//    list entry, and the approval hand-off — and never touches history itself.
export default function FeatureRequestView({
  model = 'claude-opus-5',
  onBack,
  requestId = null,
  onNavigate = () => {},
}) {
  const [request, setRequest] = useState(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  // The optimistic layer (DAN-67): user messages the server has not confirmed
  // yet, each { id, content, status: 'sending' | 'failed' }. Appended to the
  // canonical transcript in order; an entry is dropped the moment the server
  // transcript containing it arrives, and kept (marked failed, with a retry
  // control) when the round rejects.
  const [pendingMessages, setPendingMessages] = useState([])
  const nextPendingId = useRef(0)
  // Sentinel under the transcript; each append (and the thinking indicator)
  // scrolls it into view so the newest message is always visible.
  const transcriptEndRef = useRef(null)
  // The composer textarea (DAN-71), for autosizing between its 3-row floor
  // and the CSS max-height (~8 rows) as the draft grows.
  const composerRef = useRef(null)
  // The `model` prop (the seam DAN-53 left) is now the picker's initial
  // selection rather than the sent-forever value.
  const [selectedModel, setSelectedModel] = useState(model)
  // The quota meter's data: { requests, totalTokens } or null until the first
  // myAiUsage() resolves.
  const [usage, setUsage] = useState(null)
  // Sticky: once any call reports QUOTA_EXHAUSTED, the friendly panel replaces
  // the raw error and the composer disables for the rest of the visit.
  const [quotaExhausted, setQuotaExhausted] = useState(false)
  const [approving, setApproving] = useState(false)
  // DAN-76: a failed approval renders as a styled panel next to the Approve
  // button, not the bare line under the transcript that send errors use —
  // approving is a different action with a different blast radius, and its
  // error belongs next to its button. Shaped { message, detail } (detail is
  // the server's own text under the generic headline, or null when the
  // message IS the server's guidance); null when the last approval attempt
  // did not fail.
  const [approveError, setApproveError] = useState(null)

  const messages = request?.messages ?? []

  // DAN-79: which server-message indices have finished their typewriter
  // reveal. A ref, not state — completion must survive re-renders without
  // causing them, so a revealed reply never replays. Server messages present
  // at the very first render (a transcript that exists before this view does)
  // are pre-completed: only replies that *arrive* while mounted animate.
  const revealedRef = useRef(null)
  if (revealedRef.current === null) {
    revealedRef.current = new Set(messages.map((_, index) => index))
  }
  // The picker locks once the session starts — the model is baked into the
  // conversation at startFeatureRequest time.
  const sessionStarted = request !== null
  // The session has been approved and its tickets filed, so the view hands off
  // to the build DAG (DAN-55) — see BUILD_HANDOFF_STATUSES.
  const showingBuild = BUILD_HANDOFF_STATUSES.includes(request?.status)

  // DAN-74: reopen a past session from the "My requests" list. Adopting the
  // fetched FeatureRequest as `request` is the whole trick — every downstream
  // surface already renders from it: a gathering session gets its transcript,
  // gates, and live composer; a building or shipped one flips `showingBuild`
  // above, so WatchBuild mounts and polls with this id (a shipped session's
  // first poll finds every ticket DONE and stops there, showing the finished
  // graph). Two seams need explicit care:
  //  - revealedRef is REPLACED (synchronously, before the setState renders)
  //    with every index of the reopened transcript, so historical agent
  //    replies render complete instead of replaying DAN-79's typewriter —
  //    the same "present at first render" rule, re-applied at reopen.
  //  - the locked picker adopts the session's model, so the disabled radios
  //    show what the conversation was actually started with.
  function adoptRequest(existing) {
    revealedRef.current = new Set(
      (existing.messages ?? []).map((_, index) => index),
    )
    if (SELECTABLE_MODELS.includes(existing.model)) {
      setSelectedModel(existing.model)
    }
    setRequest(existing)
  }

  // Opening from the list is adoption plus a URL: the session gets its
  // `/requests/:id` history entry (DAN-82), so reload restores it and Back
  // returns to the list. The reconcile effect below sees the adopted id
  // already matches the new requestId prop and fetches nothing — the DAN-74
  // no-refetch reopen is preserved.
  function handleOpenExisting(existing) {
    adoptRequest(existing)
    onNavigate(`/requests/${existing.id}`)
  }

  // DAN-82: a deep-linked session that failed to load — NOT_FOUND, network.
  // Its own channel (not `error`): the failure happened before any
  // conversation existed, and it replaces the whole surface rather than
  // annotating one.
  const [loadError, setLoadError] = useState(null)
  // The deep link is unresolved until the fetched session is adopted; while
  // true the view renders a placeholder instead of the fresh-start surface,
  // so a usable composer never flashes before the transcript arrives.
  const loadingDeepLink =
    requestId !== null && request?.id !== requestId && loadError === null

  // Reset to the fresh start-a-request surface. Runs when Back (or forward)
  // lands on bare `/requests` from a session URL: the same instance stays
  // mounted (App renders the whole `/requests` subtree without a key), so the
  // session state must be cleared by hand — including revealedRef, so the next
  // adopted transcript pre-seeds from a clean slate.
  function resetSession() {
    revealedRef.current = new Set()
    setRequest(null)
    setPendingMessages([])
    setDraft('')
    setError(null)
    setApproveError(null)
    setLoadError(null)
    setSelectedModel(model)
  }

  // Reconcile the requestId prop (the URL) with the session in state. Three
  // transitions matter, keyed off the PREVIOUS requestId (a ref, so a session
  // legitimately started while sitting on bare `/requests` — where requestId
  // stays null throughout — is never mistaken for a back-navigation and
  // reset):
  //  - id appeared or changed, and it isn't the session already held → fetch
  //    the request and reuse the DAN-74 adoption path (gathering → chat with
  //    the transcript pre-revealed and the picker locked to the session's
  //    model; building → the DAG). This is the deep-link cold load, and also
  //    forward-button re-entry after Back.
  //  - id appeared but matches the held session (approval just pushed the
  //    URL, or a list entry was opened) → nothing to do; state survives the
  //    navigation with no refetch.
  //  - id went away after being present (Back to `/requests`) → reset to the
  //    fresh surface.
  // StrictMode's double-invoke just aborts the first fetch's adoption via the
  // cancelled flag and lets the second run land — featureRequest is a read.
  const prevRequestIdRef = useRef(requestId)
  useEffect(() => {
    const previousId = prevRequestIdRef.current
    prevRequestIdRef.current = requestId
    if (requestId === null) {
      if (previousId !== null) resetSession()
      return undefined
    }
    if (request?.id === requestId) return undefined
    let cancelled = false
    setLoadError(null)
    async function load() {
      try {
        const fetched = await featureRequest(requestId)
        if (!cancelled) adoptRequest(fetched)
      } catch (err) {
        if (!cancelled) setLoadError(err.message)
      }
    }
    load()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId])

  // Refresh the quota meter. A failed read never blocks the chat — the meter
  // just keeps its last value — but a QUOTA_EXHAUSTED rejection flips the same
  // friendly panel any other call would. Never rethrows, so callers can fire it
  // without their own handling.
  async function refreshUsage() {
    try {
      const next = await myAiUsage()
      if (next) setUsage(next)
    } catch (err) {
      if (isQuotaExhausted(err)) setQuotaExhausted(true)
    }
  }

  useEffect(() => {
    // Mount-only fetch. StrictMode's double-invoked effect just reads the
    // ledger twice — myAiUsage is a read, so no dedupe ref is needed here.
    refreshUsage()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const transcriptLength = messages.length + pendingMessages.length
  useEffect(() => {
    // Auto-scroll to the newest message on every transcript append, and again
    // when the thinking indicator mounts, so the reply's placeholder is on
    // screen. The optional call keeps jsdom happy — it does not implement
    // scrollIntoView; tests stub it on Element.prototype and assert the call.
    // Smoothness (and its prefers-reduced-motion opt-out) lives in CSS
    // scroll-behavior, not here.
    transcriptEndRef.current?.scrollIntoView?.({ block: 'end' })
  }, [transcriptLength, sending])

  // One round trip for one optimistic entry: mark it sending (creating it if
  // this is its first attempt), run the DAN-53 start-then-send sequence, and
  // reconcile. On success the server transcript already contains the delivered
  // message, so dropping the pending entry in the same update swaps the
  // optimistic copy for the canonical one with no duplicate. On failure the
  // entry stays, marked failed, so the transcript never eats the message.
  async function deliver(entryId, content) {
    setError(null)
    setPendingMessages((prev) =>
      prev.some((p) => p.id === entryId)
        ? prev.map((p) =>
            p.id === entryId ? { ...p, status: 'sending' } : p,
          )
        : [...prev, { id: entryId, content, status: 'sending' }],
    )
    setSending(true)
    try {
      let id = request?.id
      if (!id) {
        const started = await startFeatureRequest(selectedModel)
        id = started.id
        setRequest(started)
      }
      const updated = await sendFeatureRequestMessage(id, content)
      setRequest(updated)
      setPendingMessages((prev) => prev.filter((p) => p.id !== entryId))
      // Every exchange spends AI budget, so the meter refreshes after each one.
      await refreshUsage()
    } catch (err) {
      setPendingMessages((prev) =>
        prev.map((p) => (p.id === entryId ? { ...p, status: 'failed' } : p)),
      )
      if (isQuotaExhausted(err)) {
        setQuotaExhausted(true)
      } else {
        setError(err.message)
      }
    } finally {
      setSending(false)
    }
  }

  // One submit path for the three ways to send (the Send button, the form's
  // native submit, and Cmd/Ctrl+Enter): empty drafts and in-flight rounds are
  // no-ops regardless of which entry point fired.
  async function submitDraft() {
    const content = draft.trim()
    if (!content || sending) return
    // Optimistic: the composer clears the moment the message enters the
    // transcript, exactly like a chat app.
    setDraft('')
    const entryId = nextPendingId.current++
    await deliver(entryId, content)
  }

  async function handleSubmit(event) {
    event.preventDefault()
    await submitDraft()
  }

  // DAN-71: the composer is multi-line, so plain Enter keeps its default —
  // inserting a newline — and Cmd/Ctrl+Enter is the keyboard submit.
  function handleComposerKeyDown(event) {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      submitDraft()
    }
  }

  useEffect(() => {
    // Autosize the composer between its 3-row floor and the CSS max-height
    // (~8 rows; past that it scrolls). Resetting to auto first lets the box
    // shrink back when lines are deleted. jsdom reports scrollHeight as 0,
    // so tests exercise the handler without the style mattering.
    const el = composerRef.current
    if (!el) return
    el.style.height = 'auto'
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`
  }, [draft, showingBuild, quotaExhausted])

  // The "not delivered — retry" control: resend the same content against the
  // same conversation (or re-attempt the start if the first round never got
  // that far — the started request is stored before the send, so a retry can
  // never create a second conversation).
  async function handleRetry(entryId) {
    if (sending) return
    const entry = pendingMessages.find((p) => p.id === entryId)
    if (!entry) return
    await deliver(entryId, entry.content)
  }

  // Approve the plan. Only enabled when the server said approvable — the
  // client never re-derives that from the gates, so the server stays the
  // enforcement point. On success the returned request's status is "building",
  // which flips the hand-off state above.
  //
  // DAN-76 failure handling: the button re-enables (finally clears approving,
  // and nothing here flips approvable), so a second click simply re-attempts.
  // Three failure shapes, mirroring the backend's error mapper:
  //  - QUOTA_EXHAUSTED keeps the existing sticky friendly-panel behavior.
  //  - BAD_USER_INPUT ("there is no plan yet" and friends) is user guidance by
  //    design, so the server's message renders as the panel's text verbatim.
  //  - Anything else (5xx mapped to INTERNAL, network) gets the generic
  //    headline — approval is atomic on the backend, so "nothing was created"
  //    is true and retrying is safe — with the server's text kept underneath
  //    as the diagnostic detail.
  async function handleApprove() {
    if (!request || approving) return
    setApproveError(null)
    setApproving(true)
    try {
      const updated = await approveFeatureRequestPlan(request.id)
      setRequest(updated)
      // DAN-82: the approval hand-off is the moment the session becomes a
      // destination — push its URL so reload reopens this build view and Back
      // returns to the pre-approval surface. App's navigate() skips the push
      // when the session was reopened from `/requests/:id` and the URL is
      // already current. The reconcile effect sees the id already adopted and
      // fetches nothing.
      onNavigate(`/requests/${updated.id}`)
    } catch (err) {
      if (isQuotaExhausted(err)) {
        setQuotaExhausted(true)
      } else if (err?.extensions?.code === 'BAD_USER_INPUT') {
        setApproveError({ message: err.message, detail: null })
      } else {
        setApproveError({
          message: "Couldn't file the plan — nothing was created. Try again.",
          detail: err.message,
        })
      }
    } finally {
      setApproving(false)
    }
  }

  // DAN-82: an unresolved deep link renders only the frame — never a live
  // composer that could start a brand-new session while the linked one is
  // still in flight, and never the "My requests" list under a session URL. A
  // failed load says so (role=alert) and leaves Back as the way out; the rest
  // of the surface below assumes any requestId has been adopted.
  if (requestId !== null && request?.id !== requestId) {
    return (
      <>
        <button className="btn" type="button" onClick={onBack}>
          Back to records
        </button>
        <h1>Request a feature</h1>
        {loadingDeepLink ? (
          <p className="empty-state">Loading session…</p>
        ) : (
          <p role="alert">Couldn’t load this request: {loadError}</p>
        )}
      </>
    )
  }

  return (
    <>
      <button className="btn" type="button" onClick={onBack}>
        Back to records
      </button>
      <h1>Request a feature</h1>
      <fieldset className="model-picker" disabled={sessionStarted}>
        <legend>Model</legend>
        <ul className="model-picker__options">
          {SELECTABLE_MODELS.map((name) => (
            <li key={name}>
              <label className="model-picker__option">
                <input
                  type="radio"
                  name="model"
                  value={name}
                  checked={selectedModel === name}
                  onChange={() => setSelectedModel(name)}
                />
                {name}
              </label>
            </li>
          ))}
          {DISPLAY_ONLY_TOOLS.map((name) => (
            <li
              key={name}
              className="model-picker__option model-picker__option--muted"
            >
              {name} (display only)
            </li>
          ))}
        </ul>
      </fieldset>
      <section className="gates" aria-label="Entrance criteria">
        <h2>Entrance criteria</h2>
        <ul className="gates__list">
          {GATES.map(({ key, label }) => {
            const gate = request?.entranceCriteria?.[key] ?? null
            return (
              <li key={key} className="gates__item">
                <span className="gates__name">{label}</span>{' '}
                {gate ? (
                  <>
                    <span
                      className={
                        gate.pass
                          ? 'gates__state gates__state--pass'
                          : 'gates__state gates__state--fail'
                      }
                    >
                      {gate.pass ? 'Pass' : 'Fail'}
                    </span>
                    {' — '}
                    <span className="gates__reason">{gate.reason}</span>
                  </>
                ) : (
                  <span className="gates__state gates__state--pending">
                    Not yet evaluated
                  </span>
                )}
              </li>
            )
          })}
        </ul>
        {!showingBuild && (
          <>
            <button
              className="btn btn--primary"
              type="button"
              disabled={!request?.approvable || approving}
              onClick={handleApprove}
            >
              Approve plan
            </button>
            {/* DAN-76: the approval-failure panel, right under its button.
                Hidden once quota exhaustion takes over — the sticky quota
                panel is the one alert for that state. */}
            {approveError && !quotaExhausted && (
              <div className="approve-error" role="alert">
                <p className="approve-error__message">{approveError.message}</p>
                {approveError.detail && (
                  <p className="approve-error__detail">{approveError.detail}</p>
                )}
              </div>
            )}
          </>
        )}
      </section>
      <section className="quota-meter" aria-label="AI usage">
        <h2>AI usage</h2>
        {usage ? (
          <dl className="quota-meter__figures">
            <div className="quota-meter__figure">
              <dt>Requests</dt>
              <dd>{usage.requests}</dd>
            </div>
            <div className="quota-meter__figure">
              <dt>Tokens</dt>
              <dd>{usage.totalTokens}</dd>
            </div>
          </dl>
        ) : (
          <p className="empty-state">Usage not loaded yet.</p>
        )}
      </section>
      {transcriptLength === 0 ? (
        <p className="empty-state">
          Describe the feature you would like. The product owner and architect
          will reply here.
        </p>
      ) : (
        <>
          <ul className="chat-transcript" aria-label="Conversation">
            {messages.map((message, index) =>
              message.role === 'user' ? (
                // User bubbles stay exactly as DAN-53 shipped them: plain
                // text, no markdown, no reveal.
                <li
                  key={`server-${index}`}
                  className={`chat-message chat-message--${message.role}`}
                >
                  <span className="chat-message__role">{message.role}</span>
                  <p className="chat-message__content">{message.content}</p>
                </li>
              ) : (
                // Agent replies render as markdown; a reply that arrived
                // after mount (not yet in revealedRef, motion allowed) types
                // on progressively. AssistantMessage latches `animate` at
                // mount, so re-renders mid-reveal don't restart it.
                <AssistantMessage
                  key={`server-${index}`}
                  role={message.role}
                  content={message.content}
                  animate={
                    !revealedRef.current.has(index) && !prefersReducedMotion()
                  }
                  onDone={() => revealedRef.current.add(index)}
                />
              ),
            )}
            {pendingMessages.map((entry) => (
              <li
                key={`pending-${entry.id}`}
                className="chat-message chat-message--user"
              >
                <span className="chat-message__role">user</span>
                <p className="chat-message__content">{entry.content}</p>
                {entry.status === 'failed' && (
                  <p className="chat-message__undelivered">
                    not delivered —{' '}
                    <button
                      className="chat-message__retry"
                      type="button"
                      disabled={sending || quotaExhausted}
                      onClick={() => handleRetry(entry.id)}
                    >
                      retry
                    </button>
                  </p>
                )}
              </li>
            ))}
            {sending && (
              <li className="chat-message chat-message--thinking">
                <p className="chat-message__content chat-thinking" role="status">
                  product-owner is thinking…
                </p>
              </li>
            )}
          </ul>
          <div ref={transcriptEndRef} aria-hidden="true" />
        </>
      )}
      {quotaExhausted ? (
        <section className="quota-exhausted" role="alert">
          <h2>You’re out of AI quota</h2>
          <p>
            This conversation has used up the available AI allowance for now.
            Nothing was lost — your request is saved, and you can pick it up
            again once the quota resets.
          </p>
        </section>
      ) : (
        error && <p role="alert">{error}</p>
      )}
      {showingBuild ? (
        // DAN-55: the hand-off is no longer a placeholder — the approved
        // request's id is the promptId the build view polls progress for.
        // DAN-81 also hands over linearProjectUrl (null until DAN-80's backend
        // field lands) so the building view's header can link the filed Linear
        // project; the pre-approval view never shows the link or the cost stat
        // because WatchBuild only mounts here, after approval. DAN-91 hands
        // over the generated title the same way (null until DAN-90's backend
        // field lands) for the build header.
        <WatchBuild
          promptId={request.id}
          linearProjectUrl={request.linearProjectUrl ?? null}
          title={request.title ?? null}
        />
      ) : (
        <>
          <form className="chat-composer" onSubmit={handleSubmit}>
            <label className="chat-composer__field field--grow">
              Message
              <textarea
                ref={composerRef}
                className="control chat-composer__textarea"
                rows={3}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                disabled={sending || quotaExhausted}
              />
            </label>
            <button
              className="btn btn--primary"
              type="submit"
              disabled={sending || quotaExhausted}
            >
              Send
            </button>
          </form>
          <p className="chat-composer__hint">
            The team reads and replies — this can take a minute.
          </p>
        </>
      )}
      {!sessionStarted && pendingMessages.length === 0 && (
        // DAN-74: past sessions, reopenable. Only until a session is active —
        // starting or reopening one (or even having a first message in
        // flight) unmounts the list, so the default start-a-new-request flow
        // above always stays the prominent action.
        <MyRequests onOpen={handleOpenExisting} />
      )}
    </>
  )
}
