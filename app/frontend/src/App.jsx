import { useEffect, useState } from 'react'

import { listRecords } from './api.js'
import RecordTable from './RecordTable.jsx'

// State lives here and flows down (see docs/architecture.md). This ticket is
// read-only: App loads the records once on mount and hands them to the table.
// Later tickets add create/edit/delete against this same state.
export default function App() {
  const [records, setRecords] = useState([])
  const [status, setStatus] = useState('loading') // 'loading' | 'ready' | 'error'
  const [error, setError] = useState(null)

  useEffect(() => {
    // Fetch exactly once on mount. `cancelled` guards against setting state
    // after unmount (React 18 StrictMode double-invokes effects in dev).
    let cancelled = false

    async function load() {
      try {
        const data = await listRecords()
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
