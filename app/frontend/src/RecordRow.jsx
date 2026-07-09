import { useState } from 'react'

// The allowed statuses mirror the backend schema (docs/architecture.md) purely
// for the edit UX — the backend stays the enforcement point.
const STATUSES = ['active', 'pending', 'archived']

// One row. `RecordTable` owns *which* row is editing and passes `isEditing`; this
// component only renders the matching mode. Keyed upstream by the API's string
// `id` (the Mongo ObjectId never reaches the frontend). `notes` is optional, so a
// missing value renders an empty cell rather than the string "undefined".
export default function RecordRow({
  record,
  isEditing = false,
  onEdit,
  onCancel,
  onSave,
  onDelete,
}) {
  if (isEditing) {
    return (
      <EditRow record={record} onCancel={onCancel} onSave={onSave} />
    )
  }

  return (
    <tr>
      <td>{record.name}</td>
      <td>{record.status}</td>
      <td>{record.amount}</td>
      <td>{record.notes ?? ''}</td>
      <td>
        <button type="button" onClick={onEdit}>
          Edit
        </button>
        <button type="button" onClick={() => onDelete(record.id)}>
          Delete
        </button>
      </td>
    </tr>
  )
}

// Edit mode keeps its own draft state so typing doesn't mutate the record until
// Save. `amount` is a number field but the DOM gives us a string, so it is
// coerced with Number() on save; an unparseable value becomes NaN and the
// backend rejects it (400), which the optimistic caller turns into a rollback.
function EditRow({ record, onCancel, onSave }) {
  const [name, setName] = useState(record.name)
  const [status, setStatus] = useState(record.status)
  const [amount, setAmount] = useState(String(record.amount))
  const [notes, setNotes] = useState(record.notes ?? '')

  function handleSave() {
    onSave(record.id, {
      name,
      status,
      amount: Number(amount),
      notes,
    })
  }

  return (
    <tr>
      <td>
        <input
          aria-label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </td>
      <td>
        <select
          aria-label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input
          aria-label="Amount"
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </td>
      <td>
        <input
          aria-label="Notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </td>
      <td>
        <button type="button" onClick={handleSave}>
          Save
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </td>
    </tr>
  )
}
