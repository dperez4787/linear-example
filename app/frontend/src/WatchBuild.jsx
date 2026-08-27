import { useEffect, useState } from 'react'

import ActivityTimeline from './ActivityTimeline.jsx'
import {
  featureRequestActivity,
  featureRequestCost,
  featureRequestProgress,
} from './api.js'

// The watch-it-build DAG view (DAN-55): once a feature request is approved,
// FeatureRequestView hands off to this component, which polls
// featureRequestProgress(promptId) every POLL_INTERVAL_MS and renders one node
// per filed ticket, layered by topological depth over the blockedBy edges so
// blockers always appear before their dependents. No graph library and no SVG
// edges — the layering plus per-node "blocked by …" text conveys the DAG, which
// keeps dependencies at zero and the whole thing assertable through accessible
// text (see docs/architecture.md, Testing: never styles).
//
// Polling is a recursive setTimeout rather than setInterval so a slow response
// can never stack a second request behind itself, and so fake-timer tests can
// advance one hop at a time. It stops for good when every node is DONE, and on
// unmount (the cleanup both flips `cancelled` and clears the pending timer).
//
// A failed poll never blanks the view: the last good DAG stays rendered and the
// single role="status" line gains a "live view stale — retrying" note until a
// poll succeeds again. That status line is deliberately the component's only
// role="status" element outside the per-node spinners — it is the same
// accessible hand-off signal DAN-54 shipped ("…building…"), now owned here.
//
// DAN-81 adds two header pieces. A "View in Linear" link to the request's
// linearProjectUrl (a prop, read off the FeatureRequest by the parent) opens
// the filed project in a new tab; it renders only when the URL is present —
// null hides it entirely. And a "Planning cost" stat ($X.XXXX plus the call
// count) reads featureRequestCost(promptId) on the same tick as the progress
// poll — the cost fetch rides the existing recursive setTimeout, never a
// second timer — so the figure refreshes at the poll cadence and stops when
// the poll stops. A failed cost read degrades silently: the stat keeps its
// last good value (or stays absent before the first success) and never marks
// the DAG stale — staleness remains the progress poll's signal alone.
//
// DAN-84 adds the live activity pane (ActivityTimeline) beside the DAG. Its
// featureRequestActivity read rides the same tick the same way the cost read
// does: fetched alongside the progress poll, awaited before the next hop is
// scheduled — one timer total — and it starts and stops with the poll (all
// tickets DONE stops everything; unmount stops everything). Its failures are
// equally soft: the last good event list stays rendered and the DAG is never
// marked stale by an activity blip.
export const POLL_INTERVAL_MS = 5000

// Accessible per-state markers. Spinners are role="status" with distinct labels
// ("implementing" vs "under review") so the two in-flight states are
// distinguishable by text, not just by their visually distinct animations; the
// dimmed BACKLOG style is backed by the visible label "queued" so the state
// never lives in opacity alone.
function StateMarker({ state }) {
  switch (state) {
    case 'IN_PROGRESS':
      return (
        <span role="status" className="dag-node__state dag-node__state--implementing">
          <span className="spinner spinner--implementing" aria-hidden="true" />
          implementing
        </span>
      )
    case 'IN_REVIEW':
      return (
        <span role="status" className="dag-node__state dag-node__state--review">
          <span className="spinner spinner--review" aria-hidden="true" />
          under review
        </span>
      )
    case 'DONE':
      return (
        <span className="dag-node__state dag-node__state--done">
          <span aria-hidden="true">✓</span> done
        </span>
      )
    case 'BOUNCED':
      return (
        <span className="dag-node__state dag-node__state--bounced">
          <span aria-hidden="true">⚠</span> sent back
        </span>
      )
    default:
      // BACKLOG (and anything unrecognized degrades to queued rather than blank).
      return <span className="dag-node__state dag-node__state--queued">queued</span>
  }
}

// Topological depth per ticket over the blockedBy edges: 0 for roots, else one
// more than the deepest blocker. blockedBy entries are matched by identifier or
// issueId (the DAN-52 contract sends identifiers; matching both costs nothing
// and survives either). A blocker that is not in the list still pushes its
// dependent to depth >= 1, and a cycle — which the backend should never emit —
// breaks at the revisited node instead of recursing forever.
function computeDepths(tickets) {
  const byKey = new Map()
  for (const t of tickets) {
    byKey.set(t.issueId, t)
    byKey.set(t.identifier, t)
  }
  const depths = new Map()
  function depthOf(ticket, seen) {
    if (depths.has(ticket.issueId)) return depths.get(ticket.issueId)
    if (seen.has(ticket.issueId)) return 0
    seen.add(ticket.issueId)
    let depth = 0
    for (const ref of ticket.blockedBy ?? []) {
      const blocker = byKey.get(ref)
      depth = Math.max(depth, blocker ? depthOf(blocker, seen) + 1 : 1)
    }
    depths.set(ticket.issueId, depth)
    return depth
  }
  for (const t of tickets) depthOf(t, new Set())
  return depths
}

// The blockers of a ticket that are not DONE yet, named for the "blocked by …"
// line. A reference that resolves to a listed ticket uses that ticket's
// identifier and drops out once it is DONE; a reference to nothing we know
// about stays listed verbatim — unknown is not unblocked.
function unresolvedBlockers(ticket, tickets) {
  const byKey = new Map()
  for (const t of tickets) {
    byKey.set(t.issueId, t)
    byKey.set(t.identifier, t)
  }
  const out = []
  for (const ref of ticket.blockedBy ?? []) {
    const blocker = byKey.get(ref)
    if (!blocker) out.push(ref)
    else if (blocker.state !== 'DONE') out.push(blocker.identifier)
  }
  return out
}

function allDone(tickets) {
  return tickets.length > 0 && tickets.every((t) => t.state === 'DONE')
}

export default function WatchBuild({ promptId, linearProjectUrl = null }) {
  // The last good progress list, or null before the first successful poll.
  // A failed poll never writes here — that is what keeps the DAG on screen.
  const [tickets, setTickets] = useState(null)
  // True while the most recent poll failed; cleared by the next success.
  const [stale, setStale] = useState(false)
  // The last good planning-cost ledger ({ calls, tokensIn, tokensOut,
  // costUsd }), or null before the first successful read. Same
  // never-blank-on-failure rule as the DAG (DAN-81).
  const [cost, setCost] = useState(null)
  // The last good activity feed (ActivityEvent[], ascending by ts), or null
  // before the first successful read. Same never-blank-on-failure rule as the
  // DAG and the cost stat (DAN-84).
  const [events, setEvents] = useState(null)

  useEffect(() => {
    let cancelled = false
    let timer = null

    async function poll() {
      // All reads share the one tick (DAN-81/DAN-84): the cost and activity
      // fetches start alongside the progress fetch and are awaited before the
      // next hop is scheduled, so there is exactly one timer no matter how
      // many reads ride it. Each side read's own catch keeps its blips from
      // ever touching the DAG or the stale note.
      const costPromise = (async () => {
        try {
          return await featureRequestCost(promptId)
        } catch {
          return null
        }
      })()
      const activityPromise = (async () => {
        try {
          return await featureRequestActivity(promptId)
        } catch {
          return null
        }
      })()
      let done = false
      try {
        const next = await featureRequestProgress(promptId)
        if (cancelled) return
        setTickets(next)
        setStale(false)
        done = allDone(next)
      } catch {
        if (cancelled) return
        setStale(true)
      }
      const nextCost = await costPromise
      const nextEvents = await activityPromise
      if (cancelled) return
      if (nextCost) setCost(nextCost)
      if (nextEvents) setEvents(nextEvents)
      if (!done) timer = setTimeout(poll, POLL_INTERVAL_MS)
    }

    poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [promptId])

  const finished = tickets !== null && allDone(tickets)
  const depths = tickets ? computeDepths(tickets) : null
  // Layers in depth order; within a layer, tickets keep their server order.
  const layers = []
  if (tickets) {
    for (const t of tickets) {
      const d = depths.get(t.issueId)
      ;(layers[d] ??= []).push(t)
    }
  }

  return (
    <section className="watch-build" aria-label="Build progress">
      <header className="watch-build__header">
        <h2>Build progress</h2>
        {linearProjectUrl && (
          <a
            className="watch-build__linear-link"
            href={linearProjectUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            View in Linear
          </a>
        )}
        {cost && (
          <p className="watch-build__cost">
            Planning cost{' '}
            <span className="watch-build__cost-figure">
              ${cost.costUsd.toFixed(4)}
            </span>{' '}
            · {cost.calls} {cost.calls === 1 ? 'call' : 'calls'}
          </p>
        )}
      </header>
      <p role="status" className="watch-build__status">
        {finished
          ? 'Build complete — every ticket is done.'
          : 'Plan approved — the team is building this feature.'}
        {stale && ' Live view stale — retrying.'}
      </p>
      <div className="watch-build__body">
        <div className="watch-build__dag">
          {tickets === null ? (
            <p className="empty-state">Loading build progress…</p>
          ) : tickets.length === 0 ? (
            <p className="empty-state">No tickets filed yet.</p>
          ) : (
            <ol className="dag" aria-label="Build stages">
              {layers.map((layer, i) => (
                <li key={i} className="dag__layer">
                  <h3 className="dag__layer-name">Stage {i + 1}</h3>
                  <ul className="dag__nodes">
                    {layer.map((ticket) => {
                      const blockers = unresolvedBlockers(ticket, tickets)
                      return (
                        <li
                          key={ticket.issueId}
                          className={
                            ticket.state === 'BACKLOG'
                              ? 'dag-node dag-node--backlog'
                              : 'dag-node'
                          }
                        >
                          <a className="dag-node__issue" href={ticket.issueUrl}>
                            {ticket.identifier}
                          </a>{' '}
                          <span className="dag-node__title">{ticket.title}</span>{' '}
                          <StateMarker state={ticket.state} />
                          {ticket.prUrl && (
                            <>
                              {' '}
                              <a className="dag-node__pr" href={ticket.prUrl}>
                                PR
                              </a>
                            </>
                          )}
                          {blockers.length > 0 && (
                            <p className="dag-node__blocked">
                              blocked by {blockers.join(', ')}
                            </p>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </li>
              ))}
            </ol>
          )}
        </div>
        <ActivityTimeline events={events} />
      </div>
    </section>
  )
}
