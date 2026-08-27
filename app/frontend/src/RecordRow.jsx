import { useState } from 'react'

import { useTranslation } from './i18n.js'

// The allowed statuses mirror the backend schema (docs/architecture.md) purely
// for the edit UX — the backend stays the enforcement point.
const STATUSES = ['active', 'pending', 'archived']

// One row. `RecordTable` owns *which* row is editing and passes `isEditing`; this
// component only renders the matching mode. Keyed upstream by the API's string
// `id` (the Mongo ObjectId never reaches the frontend). `notes` is optional, so a
// missing value renders an empty cell rather than the string "undefined".
//
// The `Updated` cell is read-only in both modes — the server owns `updatedAt`,
// so it is never editable inline — and shows the ISO date (updatedAt.slice(0,10)),
// not a locale-formatted string, so tests assert on it deterministically. A row
// without an updatedAt (e.g. a not-yet-reconciled optimistic value) renders an
// empty cell rather than crashing on .slice.
function updatedDate(record) {
  return record.updatedAt ? record.updatedAt.slice(0, 10) : ''
}
export default function RecordRow({
  record,
  isEditing = false,
  onEdit,
  onCancel,
  onSave,
  onDelete,
}) {
  const { t } = useTranslation()

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
      <td>{updatedDate(record)}</td>
      <td>
        <button type="button" onClick={onEdit}>
          {t('records.row.edit')}
        </button>
        <button type="button" onClick={() => onDelete(record.id)}>
          {t('records.row.delete')}
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
  const { t } = useTranslation()
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
          aria-label={t('records.row.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </td>
      <td>
        <select
          aria-label={t('records.row.status')}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`records.status.${s}`)}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input
          aria-label={t('records.row.amount')}
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </td>
      <td>
        <input
          aria-label={t('records.row.notes')}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </td>
      <td>{updatedDate(record)}</td>
      <td>
        <button type="button" onClick={handleSave}>
          {t('records.row.save')}
        </button>
        <button type="button" onClick={onCancel}>
          {t('records.row.cancel')}
        </button>
      </td>
    </tr>
  )
}
