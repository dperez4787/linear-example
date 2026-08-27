import { useEffect, useState } from 'react'

import {
  approveFeatureRequestPlan,
  myAiUsage,
  sendFeatureRequestMessage,
  startFeatureRequest,
} from './api.js'

// The "Request a feature" chat pane (DAN-53), extended by DAN-54 with the model
// picker, the entrance-criteria checklist, the quota meter, the friendly
// quota-exhausted state, and the Approve button. Rendered by App in place of
// the records view — App owns which view is showing (state-based switching, no
// router); this component owns the conversation.
//
// The transcript is whatever the server last returned: submitting a message
// resolves to the updated FeatureRequest whose messages array already contains
// the user's message plus the role-labeled replies, so the transcript is set
// from the response rather than assembled locally. Not optimistic on purpose —
// unlike the records table (where a rollback restores a value the user can
// still see), a chat message that silently vanished on failure would read as
// the app eating input, so the message stays in the composer until the server
// accepts it. The checklist and the Approve gate ride the same wave: they are
// pure renderings of the last FeatureRequest the server returned
// (entranceCriteria / approvable), so they update after every exchange with no
// extra fetch.
//
// The first submit lazily starts the conversation: startFeatureRequest(model),
// then sendFeatureRequestMessage with the new id. The started request is stored
// before the send, so a failed first send retries against the same conversation
// instead of creating a second one.

// The picker's rows (DAN-54). Exactly one selectable model in v1. The "coming
// soon" models render as disabled radios so they are visibly on the roadmap but
// unpickable; the coding tools render as display-only entries with no input at
// all, so they can never be selected whether or not the picker is locked.
const SELECTABLE_MODELS = ['claude-opus-5']
const COMING_SOON_MODELS = ['gpt-5.6-terra', 'gemini-3.6-flash', 'gpt-oss-120b']
const DISPLAY_ONLY_TOOLS = ['Copilot', 'Cursor', 'Amp']

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

export default function FeatureRequestView({ model = 'claude-opus-5', onBack }) {
  const [request, setRequest] = useState(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
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

  const messages = request?.messages ?? []
  // The picker locks once the session starts — the model is baked into the
  // conversation at startFeatureRequest time.
  const sessionStarted = request !== null
  // Approval succeeded: the server flipped the request to "building", which
  // hands the view off (the build DAG view itself is DAN-55).
  const building = request?.status === 'building'

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

  async function handleSubmit(event) {
    event.preventDefault()
    const content = draft.trim()
    if (!content || sending) return
    setError(null)
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
      setDraft('')
      // Every exchange spends AI budget, so the meter refreshes after each one.
      await refreshUsage()
    } catch (err) {
      if (isQuotaExhausted(err)) {
        setQuotaExhausted(true)
      } else {
        setError(err.message)
      }
    } finally {
      setSending(false)
    }
  }

  // Approve the plan. Only enabled when the server said approvable — the
  // client never re-derives that from the gates, so the server stays the
  // enforcement point. On success the returned request's status is "building",
  // which flips the hand-off state above.
  async function handleApprove() {
    if (!request || approving) return
    setError(null)
    setApproving(true)
    try {
      const updated = await approveFeatureRequestPlan(request.id)
      setRequest(updated)
    } catch (err) {
      if (isQuotaExhausted(err)) {
        setQuotaExhausted(true)
      } else {
        setError(err.message)
      }
    } finally {
      setApproving(false)
    }
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
          {COMING_SOON_MODELS.map((name) => (
            <li key={name}>
              <label className="model-picker__option model-picker__option--muted">
                <input type="radio" name="model" value={name} disabled />
                {name} (coming soon)
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
        {!building && (
          <button
            className="btn btn--primary"
            type="button"
            disabled={!request?.approvable || approving}
            onClick={handleApprove}
          >
            Approve plan
          </button>
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
      {messages.length === 0 ? (
        <p className="empty-state">
          Describe the feature you would like. The product owner and architect
          will reply here.
        </p>
      ) : (
        <ul className="chat-transcript" aria-label="Conversation">
          {messages.map((message, index) => (
            <li
              key={index}
              className={`chat-message chat-message--${message.role}`}
            >
              <span className="chat-message__role">{message.role}</span>
              <p className="chat-message__content">{message.content}</p>
            </li>
          ))}
        </ul>
      )}
      {sending && <p role="status">Sending…</p>}
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
      {building ? (
        <p role="status" className="build-handoff">
          Plan approved — the team is building this feature. Progress will
          appear here once the build view ships.
        </p>
      ) : (
        <form className="chat-composer" onSubmit={handleSubmit}>
          <label className="chat-composer__field field--grow">
            Message
            <input
              className="control"
              type="text"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
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
      )}
    </>
  )
}
