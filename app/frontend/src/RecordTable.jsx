import { useState } from 'react'

import RecordRow from './RecordRow.jsx'

// Renders the records as a table and owns the single piece of view state this
// ticket introduces: *which* row is currently in edit mode (see
// docs/architecture.md — RecordTable owns the editing row, not RecordRow and not
// App). The record data and the mutations themselves live in App and flow down
// as `onSave`/`onDelete`; this component just decides which row shows inputs.
//
// An empty set still renders the table (with its header) plus a visible empty
// state, so the page never crashes on zero rows.
export default function RecordTable({ records, onSave, onDelete }) {
  const [editingId, setEditingId] = useState(null)

  // Leave edit mode immediately and hand the change to App, which applies it to
  // the list optimistically (so the new value shows at once, before the PATCH
  // resolves) and rolls it back with an error if the request fails. The row does
  // not wait on the request — that is what makes the edit feel instant.
  function handleSave(id, patch) {
    setEditingId(null)
    onSave(id, patch)
  }

  return (
    <table>
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Status</th>
          <th scope="col">Amount</th>
          <th scope="col">Notes</th>
          <th scope="col">Actions</th>
        </tr>
      </thead>
      <tbody>
        {records.length === 0 ? (
          <tr>
            <td colSpan={5}>No records yet.</td>
          </tr>
        ) : (
          records.map((record) => (
            <RecordRow
              key={record.id}
              record={record}
              isEditing={editingId === record.id}
              onEdit={() => setEditingId(record.id)}
              onCancel={() => setEditingId(null)}
              onSave={handleSave}
              onDelete={onDelete}
            />
          ))
        )}
      </tbody>
    </table>
  )
}
