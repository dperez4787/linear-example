import { useEffect, useRef, useState } from 'react'

import { useTranslation } from './i18n.js'
import { renderMarkdown } from './markdown.jsx'

// DAN-84: the live activity pane beside the build DAG. Purely presentational —
// WatchBuild owns the featureRequestActivity read — it rides the progress
// poll's tick, DAN-81 style — and hands the last good event list down as the
// `events` prop: null before the first successful read, else ActivityEvent[]
// ascending by ts, so the newest event is naturally at the bottom.
//
// Accessibility follows the house rules (docs/architecture.md, Testing: never
// styles): the feed is an <ol role="log"> — a live region whose additions are
// announced politely — and every event's state lives in text: a <time> stamp,
// the ticket badge, and the server's summary rendered verbatim (summaries are
// text, never parsed — "PR merged for…"/"PR closed for…" variants render
// as-is). Comment bodies expand behind a real <button> with aria-expanded,
// and the body is markdown, rendered with the DAN-79 chat renderer — same
// injection-safe pipeline as the chat bubbles.
//
// Auto-scroll: the list keeps itself pinned to the newest entry only while
// the reader is already at the bottom. A scroll listener records whether the
// viewport sits within AT_BOTTOM_EPSILON_PX of the bottom; when new events
// arrive, the effect re-pins only if it did. Scrolling up to read history is
// therefore never yanked away by the next poll tick.
export const AT_BOTTOM_EPSILON_PX = 4

// Wall-clock time for the stamp. The full ISO instant stays on the <time>
// element's dateTime attribute; an unparseable ts degrades to the raw string
// rather than "Invalid Date".
function formatTime(ts) {
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ts
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export default function ActivityTimeline({ events }) {
  const { t } = useTranslation()
  // Keys of the comment events whose bodies are expanded. Keyed by position +
  // ts + ticket so an append-only feed keeps every open body open across polls.
  const [expandedKeys, setExpandedKeys] = useState(() => new Set())
  const listRef = useRef(null)
  // Whether the reader was at the bottom at the last scroll — starts true so
  // the first batch of events lands pinned to the newest entry.
  const atBottomRef = useRef(true)

  function handleScroll() {
    const el = listRef.current
    if (!el) return
    atBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_EPSILON_PX
  }

  useEffect(() => {
    const el = listRef.current
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [events])

  function toggle(key) {
    setExpandedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <section className="activity-timeline" aria-label={t('activity.paneLabel')}>
      {/* h4, not h3: the DAG's stage headings own level 3, and the DAN-55
          suite asserts the exact set of level-3 headings — the pane title
          stays out of that outline level. */}
      <h4 className="activity-timeline__title">{t('activity.heading')}</h4>
      {events === null ? (
        <p className="empty-state">{t('activity.loading')}</p>
      ) : events.length === 0 ? (
        <p className="empty-state">{t('activity.empty')}</p>
      ) : (
        <ol
          ref={listRef}
          onScroll={handleScroll}
          role="log"
          aria-label={t('activity.eventsLabel')}
          className="activity-timeline__list"
        >
          {events.map((event, i) => {
            const key = `${i}|${event.ts}|${event.ticketIdentifier}`
            const hasBody =
              event.kind === 'comment' &&
              typeof event.body === 'string' &&
              event.body.length > 0
            const open = expandedKeys.has(key)
            return (
              <li
                key={key}
                className={`activity-event activity-event--${event.kind}`}
              >
                <time className="activity-event__time" dateTime={event.ts}>
                  {formatTime(event.ts)}
                </time>{' '}
                <span className="activity-event__badge">
                  {event.ticketIdentifier}
                </span>{' '}
                {event.url ? (
                  <a
                    className="activity-event__summary"
                    href={event.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {event.summary}
                  </a>
                ) : (
                  <span className="activity-event__summary">
                    {event.summary}
                  </span>
                )}
                {hasBody && (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="activity-event__toggle"
                      aria-expanded={open}
                      onClick={() => toggle(key)}
                    >
                      {open
                        ? t('activity.hideComment')
                        : t('activity.showComment')}
                    </button>
                    {open && (
                      <div className="activity-event__body">
                        {renderMarkdown(event.body)}
                      </div>
                    )}
                  </>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
