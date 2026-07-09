import { useEffect, useRef, useState } from 'react'

import { deleteRecord, listRecords, updateRecord } from './api.js'
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

  return (
    <main>
      <h1>Records</h1>
      {status === 'loading' && <p>Loading records…</p>}
      {status === 'error' && <p role="alert">Could not load records: {error}</p>}
      {status === 'ready' && (
        <>
          {actionError && <p role="alert">{actionError}</p>}
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
