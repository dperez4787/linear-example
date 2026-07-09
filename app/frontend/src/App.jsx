import { useEffect, useRef, useState } from 'react'

import { listRecords } from './api.js'
import RecordTable from './RecordTable.jsx'

// State lives here and flows down (see docs/architecture.md). This ticket is
// read-only: App loads the records once on mount and hands them to the table.
// Later tickets add create/edit/delete against this same state.
export default function App() {
  const [records, setRecords] = useState([])
  const [status, setStatus] = useState('loading') // 'loading' | 'ready' | 'error'
  const [error, setError] = useState(null)
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

  return (
    <main>
      <h1>Records</h1>
      {status === 'loading' && <p>Loading records…</p>}
      {status === 'error' && <p role="alert">Could not load records: {error}</p>}
      {status === 'ready' && <RecordTable records={records} />}
    </main>
  )
}
