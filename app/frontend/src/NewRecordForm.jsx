import { useState } from 'react'

// The allowed statuses mirror the backend schema (docs/architecture.md) for the
// input UX only — the backend stays the enforcement point, so the form does no
// validation of its own and lets a rejected submit come back as a field-scoped
// 400 (see below).
const STATUSES = ['active', 'pending', 'archived']

const EMPTY = { name: '', status: 'active', amount: '', notes: '' }

// The create form. State lives in App and flows down (docs/architecture.md); this
// form owns only its own draft inputs and the *validation error* it got back,
// then delegates the actual create to `onCreate`, which App uses to append the
// server's record to the table.
//
// Unlike edit/delete, create is NOT optimistic: there is no id or timestamps to
// show until the server responds, and the row must not appear on a 400. So the
// form awaits `onCreate`; on success it clears the draft (App has already added
// the returned record), and on failure it surfaces the error. A 400 carries the
// offending `field` (name|status|amount|notes) on the thrown Error, so the
// message is shown against that input — aria-invalid + a field-scoped alert —
// rather than as a generic banner. Any error without a field (network, 500) is
// shown as a form-level alert.
//
// Inputs carry only `aria-label`s (prefixed "New " so they never collide with
// the "Name"/"Amount"/… labels the edit row uses), matching the label-less input
// style RecordRow's edit mode already established.
export default function NewRecordForm({ onCreate }) {
  const [draft, setDraft] = useState(EMPTY)
  const [fieldError, setFieldError] = useState(null) // { field, message } | null
  const [formError, setFormError] = useState(null) // string | null
  const [submitting, setSubmitting] = useState(false)

  function update(field, value) {
    setDraft((d) => ({ ...d, [field]: value }))
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setFieldError(null)
    setFormError(null)
    setSubmitting(true)
    try {
      // amount is a number field but the DOM hands us a string; coerce it so an
      // unparseable value becomes NaN and the backend rejects it (400) rather
      // than silently storing something wrong.
      await onCreate({
        name: draft.name,
        status: draft.status,
        amount: Number(draft.amount),
        notes: draft.notes,
      })
      // Success: the record is in the table now. Reset for the next entry.
      setDraft(EMPTY)
    } catch (err) {
      if (err.field) {
        setFieldError({ field: err.field, message: err.message })
      } else {
        setFormError(err.message)
      }
    } finally {
      setSubmitting(false)
    }
  }

  // The message for a field, or null. Used to set aria-invalid and to render a
  // colocated role="alert" wired to the input via aria-describedby.
  const errorFor = (field) => (fieldError?.field === field ? fieldError.message : null)

  return (
    <form aria-label="New record" onSubmit={handleSubmit}>
      <h2>Add a record</h2>
      {formError && <p role="alert">{formError}</p>}

      <input
        aria-label="New name"
        placeholder="Name"
        aria-invalid={errorFor('name') ? 'true' : undefined}
        aria-describedby={errorFor('name') ? 'new-name-error' : undefined}
        value={draft.name}
        onChange={(e) => update('name', e.target.value)}
      />
      {errorFor('name') && (
        <span id="new-name-error" role="alert">
          {errorFor('name')}
        </span>
      )}

      <select
        aria-label="New status"
        aria-invalid={errorFor('status') ? 'true' : undefined}
        aria-describedby={errorFor('status') ? 'new-status-error' : undefined}
        value={draft.status}
        onChange={(e) => update('status', e.target.value)}
      >
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      {errorFor('status') && (
        <span id="new-status-error" role="alert">
          {errorFor('status')}
        </span>
      )}

      <input
        aria-label="New amount"
        type="number"
        placeholder="Amount"
        aria-invalid={errorFor('amount') ? 'true' : undefined}
        aria-describedby={errorFor('amount') ? 'new-amount-error' : undefined}
        value={draft.amount}
        onChange={(e) => update('amount', e.target.value)}
      />
      {errorFor('amount') && (
        <span id="new-amount-error" role="alert">
          {errorFor('amount')}
        </span>
      )}

      <input
        aria-label="New notes"
        placeholder="Notes"
        aria-invalid={errorFor('notes') ? 'true' : undefined}
        aria-describedby={errorFor('notes') ? 'new-notes-error' : undefined}
        value={draft.notes}
        onChange={(e) => update('notes', e.target.value)}
      />
      {errorFor('notes') && (
        <span id="new-notes-error" role="alert">
          {errorFor('notes')}
        </span>
      )}

      <button type="submit" disabled={submitting}>
        Add
      </button>
    </form>
  )
}
