import { useEffect, useState } from 'react'

import { listFeatureRequests } from './api.js'

// The "My requests" list (DAN-74): the caller's past feature-request sessions,
// newest first, each reopenable with a click. Rendered by FeatureRequestView
// below the start-a-new-request surface and only until a session is active —
// starting (or reopening) a conversation unmounts the list, so it can never
// interfere with the picker/composer flow.
//
// The list is presentation only: it fetches via listFeatureRequests() and hands
// the *full* FeatureRequest to onOpen. The parent owns what reopening means
// (chat with transcript + gates for a gathering session, the build DAG for a
// building one) — this component never inspects status beyond displaying it.
//
// A failed load degrades to a quiet inline note rather than an alert: the list
// is a convenience surface, and a broken list must never block starting a new
// request. Deliberately NOT role="alert" — the chat's error channel owns that.

// DAN-91: a row leads with the request's generated title when it has one, and
// with this preview only when it does not — see rowLabelOf below.
//
// Row preview: the first user message, truncated. 80 chars keeps a row to one
// line at typical widths; the ellipsis marks the cut.
export const PREVIEW_MAX_CHARS = 80

export function previewOf(request) {
  const first = (request.messages ?? []).find((m) => m.role === 'user')
  if (!first) return '(no messages yet)'
  const text = first.content
  if (text.length <= PREVIEW_MAX_CHARS) return text
  return `${text.slice(0, PREVIEW_MAX_CHARS - 1)}…`
}

// What the row leads with (DAN-91). When the request carries a generated title
// — DAN-90's snake_case slug, e.g. `change_buttons_to_green` — that slug is the
// label, rendered exactly as the backend produced it: no case changes, no
// underscore-to-space rewriting, no truncation in JS (a long slug is trimmed by
// the row's existing one-line ellipsis, so the layout is the same either way).
// A null title — legacy sessions, and any session whose plan has not been
// approved yet — falls back to the DAN-74 first-message preview, unchanged. An
// empty/whitespace-only title is treated as absent rather than rendered blank.
export function rowLabelOf(request) {
  const title = request.title
  if (typeof title === 'string' && title.trim() !== '') return title
  return previewOf(request)
}

// Deterministic date display (explicit locale, so tests and users see the same
// string): "Aug 27, 2026". An unparsable createdAt falls back to the raw value
// rather than "Invalid Date".
export function createdOn(request) {
  const date = new Date(request.createdAt)
  if (Number.isNaN(date.getTime())) return request.createdAt
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

// Newest first, even if the server ever returns another order — createdAt is an
// ISO-8601 string, so string comparison is chronological.
function newestFirst(requests) {
  return [...requests].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
  )
}

export default function MyRequests({ onOpen }) {
  // 'loading' | 'ready' | 'error'; requests only meaningful when 'ready'.
  const [status, setStatus] = useState('loading')
  const [requests, setRequests] = useState([])

  useEffect(() => {
    // Mount-only fetch, cancelled-flag guarded (StrictMode double-invokes the
    // effect; listFeatureRequests is a read, so the duplicate is harmless).
    let cancelled = false
    async function load() {
      try {
        const list = await listFeatureRequests()
        if (cancelled) return
        setRequests(newestFirst(list))
        setStatus('ready')
      } catch {
        if (cancelled) return
        setStatus('error')
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section className="my-requests" aria-label="My requests">
      <h2>My requests</h2>
      {status === 'loading' ? (
        <p className="empty-state">Loading your requests…</p>
      ) : status === 'error' ? (
        <p className="empty-state">Couldn’t load your past requests.</p>
      ) : requests.length === 0 ? (
        <p className="empty-state">No requests yet.</p>
      ) : (
        <ul className="my-requests__list">
          {requests.map((request) => (
            <li key={request.id} className="my-requests__item">
              <button
                type="button"
                className="my-requests__row"
                onClick={() => onOpen(request)}
              >
                <span className="my-requests__preview">
                  {rowLabelOf(request)}
                </span>{' '}
                <span
                  className={`my-requests__status my-requests__status--${request.status}`}
                >
                  {request.status}
                </span>{' '}
                <span className="my-requests__date">{createdOn(request)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
