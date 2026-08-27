import { useState } from 'react'

import { sendFeatureRequestMessage, startFeatureRequest } from './api.js'

// The "Request a feature" chat pane (DAN-53). Rendered by App in place of the
// records view — App owns which view is showing (state-based switching, no
// router); this component owns the conversation.
//
// The transcript is whatever the server last returned: submitting a message
// resolves to the updated FeatureRequest whose messages array already contains
// the user's message plus the role-labeled replies, so the transcript is set
// from the response rather than assembled locally. Not optimistic on purpose —
// unlike the records table (where a rollback restores a value the user can
// still see), a chat message that silently vanished on failure would read as
// the app eating input, so the message stays in the composer until the server
// accepts it.
//
// The first submit lazily starts the conversation: startFeatureRequest(model),
// then sendFeatureRequestMessage with the new id. The started request is stored
// before the send, so a failed first send retries against the same conversation
// instead of creating a second one. `model` is a prop with the v1 default
// hardcoded; the model picker is DAN-54's ticket and will feed this seam.
export default function FeatureRequestView({ model = 'claude-opus-5', onBack }) {
  const [request, setRequest] = useState(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)

  const messages = request?.messages ?? []

  async function handleSubmit(event) {
    event.preventDefault()
    const content = draft.trim()
    if (!content || sending) return
    setError(null)
    setSending(true)
    try {
      let id = request?.id
      if (!id) {
        const started = await startFeatureRequest(model)
        id = started.id
        setRequest(started)
      }
      const updated = await sendFeatureRequestMessage(id, content)
      setRequest(updated)
      setDraft('')
    } catch (err) {
      setError(err.message)
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      <button className="btn" type="button" onClick={onBack}>
        Back to records
      </button>
      <h1>Request a feature</h1>
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
      {error && <p role="alert">{error}</p>}
      <form className="chat-composer" onSubmit={handleSubmit}>
        <label className="chat-composer__field field--grow">
          Message
          <input
            className="control"
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={sending}
          />
        </label>
        <button className="btn btn--primary" type="submit" disabled={sending}>
          Send
        </button>
      </form>
    </>
  )
}
