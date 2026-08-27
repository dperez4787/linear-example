import { useEffect, useRef, useState } from 'react'

import { createRecord, deleteRecord, listRecords, updateRecord } from './api.js'
import FeatureRequestView from './FeatureRequestView.jsx'
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
export default function App() {
  // Which view is showing (DAN-53). State-based switching, no router — the app
  // has one other view and a router would be a dependency the next reader has
  // to learn. Both views render inside AuthGate (main.jsx wraps App), so the
  // feature-request view is behind the same sign-in gate as the records table,
  // and flipping this state never reloads the page. The records state below
  // stays mounted-and-owned by App while the chat is showing, so coming back
  // is instant and re-fetches nothing.
  const [view, setView] = useState('records') // 'records' | 'feature-request'
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

  if (view === 'feature-request') {
    return (
      <main className="container">
        <FeatureRequestView onBack={() => setView('records')} />
      </main>
    )
  }

  return (
    <main className="container">
      <div className="view-header">
        <h1>Records</h1>
        <button
          className="btn"
          type="button"
          onClick={() => setView('feature-request')}
        >
          Request a feature
        </button>
      </div>
      {status === 'loading' && <p>Loading records…</p>}
      {status === 'error' && <p role="alert">Could not load records: {error}</p>}
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
