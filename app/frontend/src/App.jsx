import { useEffect, useRef, useState } from 'react'

import { createRecord, deleteRecord, listRecords, updateRecord } from './api.js'
import FeatureRequestView from './FeatureRequestView.jsx'
import { useTranslation } from './i18n.js'
import NewRecordForm from './NewRecordForm.jsx'
import RecordTable from './RecordTable.jsx'

// State lives here and flows down (see docs/architecture.md). App loads the
// records once on mount and hands them to the table. Edit and delete are
// optimistic-with-rollback: the change is applied to local state immediately,
// the request fires, and the prior state is restored (plus an error surfaced) if
// it fails. Crucially this NEVER re-fetches the list — the mount request is
// cached in `requestRef` to dedupe StrictMode's double-mount (see below), and
// awaiting that stale promise again would replay pre-edit data. Reconciling each
// mutation from its own single-record response keeps the list authoritative
// without ever touching that ref again.

// -- DAN-82: History-API routing ---------------------------------------------
//
// DAN-53's state-based view switch grows real URLs, still with no router
// dependency: the app has exactly three paths, and a hand-rolled parse of
// location.pathname is less for the next reader to learn than a router's API.
//  - `/`             → the records table (and the fallback for unknown paths,
//                      so a mistyped deep link degrades to the home view
//                      instead of a dead end)
//  - `/requests`     → the request-a-feature surface: picker + composer with
//                      the DAN-74 "My requests" list underneath
//  - `/requests/:id` → one feature-request session, loaded by id (chat while
//                      it is gathering, the DAN-55 build DAG once building)
// Everything renders inside AuthGate exactly as before (main.jsx wraps App),
// so every path sits behind the same sign-in gate. Firebase Hosting rewrites
// `**` to the SPA, so a deep link cold-loads this same bundle and the mount
// parse below picks the view.
//
// parseRoute is the single source of truth for pathname → view; exported for
// tests. The id segment is percent-decoded (ids are server-generated and safe,
// but a hand-typed malformed escape must not crash the parse — it falls back
// to the raw segment).
export function parseRoute(pathname) {
  if (pathname === '/requests' || pathname === '/requests/') {
    return { view: 'feature-request', requestId: null }
  }
  const match = /^\/requests\/([^/]+)\/?$/.exec(pathname)
  if (match) {
    let id = match[1]
    try {
      id = decodeURIComponent(id)
    } catch {
      // Malformed percent-escape — keep the raw segment.
    }
    return { view: 'feature-request', requestId: id }
  }
  return { view: 'records', requestId: null }
}

export default function App() {
  // The current route, parsed from the real URL at mount (deep links) and kept
  // in sync two ways: navigate() below for in-app transitions (pushState, so
  // the URL changes with no reload) and the popstate listener for the browser's
  // back/forward buttons. The records state below stays mounted-and-owned by
  // App while the records view shows, exactly as before.
  const { t } = useTranslation()
  const [route, setRoute] = useState(() =>
    parseRoute(window.location.pathname),
  )
  const [records, setRecords] = useState([])
  const [status, setStatus] = useState('loading') // 'loading' | 'ready' | 'error'
  const [error, setError] = useState(null)
  // Error from an edit/delete (distinct from the load error above). Surfaced to
  // the user and cleared when the next mutation starts.
  const [actionError, setActionError] = useState(null)
  // Caches the single in-flight request. StrictMode double-invokes effects in
  // dev (mount → cleanup → mount) on the same component instance, so a per-effect
  // `cancelled` flag stops the second render from writing state but does NOT stop
  // it from firing a second listRecords(). Because the ref survives that cycle,
  // both effect runs await the *same* promise — the request goes out exactly once,
  // and the surviving second effect still applies the result.
  const requestRef = useRef(null)

  // In-app navigation: push the new URL onto history, then render the view for
  // it. Pushing an entry the user is already on would make Back a no-op click
  // eater, so an already-current path only re-syncs state. Handed down to the
  // feature-request view, whose approval hand-off and list clicks push
  // `/requests/:id` through this same function.
  function navigate(path) {
    if (window.location.pathname !== path) {
      window.history.pushState(null, '', path)
    }
    setRoute(parseRoute(path))
  }

  useEffect(() => {
    // Back/forward: the browser already moved the URL; re-parse it into view
    // state. Mount-only — the listener reads location fresh on every event, so
    // it never goes stale.
    function onPopState() {
      setRoute(parseRoute(window.location.pathname))
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    // `cancelled` guards against setting state after this effect run is torn down
    // (StrictMode cleanup, or a real unmount). It's per-run; the ref is shared.
    let cancelled = false

    async function load() {
      try {
        if (!requestRef.current) requestRef.current = listRecords()
        const data = await requestRef.current
        if (!cancelled) {
          setRecords(data)
          setStatus('ready')
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message)
          setStatus('error')
        }
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [])

  // Optimistic edit. Apply the patch to local state before the PATCH resolves so
  // the table shows the new value instantly; on success reconcile with the
  // server's record (picks up updatedAt and any normalization); on failure
  // restore the exact prior list and surface the error. Captures `records` for
  // the rollback snapshot — mutations here are one-at-a-time (a row is either in
  // edit mode or not), so a stale snapshot across concurrent saves is not a case
  // this UI produces.
  async function handleSave(id, patch) {
    setActionError(null)
    const previous = records
    setRecords((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))
    try {
      const updated = await updateRecord(id, patch)
      setRecords((rs) => rs.map((r) => (r.id === id ? updated : r)))
    } catch (err) {
      setRecords(previous)
      setActionError(err.message)
    }
  }

  // Create. Deliberately NOT optimistic and deliberately NOT a re-fetch: the new
  // row has no server id or timestamps until the POST returns, and re-listing
  // would re-await the cached mount promise (requestRef) and replay the stale
  // pre-create list — the new row would never appear. Instead, append the record
  // the API returns (its own 201 { record } response, already unwrapped) to local
  // state; that is the same "reconcile from the mutation's own response, never
  // touch requestRef" rule the edit/delete paths follow. On a 400 nothing is
  // appended and the error is re-thrown so NewRecordForm can point it at the
  // offending field.
  async function handleCreate(input) {
    const created = await createRecord(input)
    setRecords((rs) => [...rs, created])
  }

  // Optimistic delete. Drop the row immediately; if the DELETE fails, restore the
  // prior list and surface the error.
  async function handleDelete(id) {
    setActionError(null)
    const previous = records
    setRecords((rs) => rs.filter((r) => r.id !== id))
    try {
      await deleteRecord(id)
    } catch (err) {
      setRecords(previous)
      setActionError(err.message)
    }
  }

  if (route.view === 'feature-request') {
    // One mounted instance covers `/requests` and `/requests/:id` (no key), so
    // navigating between the list and a session keeps component state alive —
    // the view reconciles a changing requestId itself (fetch-and-adopt on a
    // deep link, reset when Back lands on the bare list).
    return (
      <main className="container">
        <FeatureRequestView
          requestId={route.requestId}
          onNavigate={navigate}
          onBack={() => navigate('/')}
        />
      </main>
    )
  }

  return (
    <main className="container">
      <div className="view-header">
        <h1>{t('records.title')}</h1>
        <button
          className="btn"
          type="button"
          onClick={() => navigate('/requests')}
        >
          {t('records.requestFeature')}
        </button>
      </div>
      {status === 'loading' && <p>{t('records.loading')}</p>}
      {status === 'error' && (
        <p role="alert">{t('records.loadError', { message: error })}</p>
      )}
      {status === 'ready' && (
        <>
          {actionError && <p role="alert">{actionError}</p>}
          <NewRecordForm onCreate={handleCreate} />
          <RecordTable
            records={records}
            onSave={handleSave}
            onDelete={handleDelete}
          />
        </>
      )}
    </main>
  )
}
