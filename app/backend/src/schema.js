// The single source of truth for Record validation. Applied on create and on
// update (PATCH) via the same per-field validators, so a partial update can
// never store a value that create would have rejected. The frontend may mirror
// these rules for UX but is never the enforcement point — see docs/architecture.md.
//
// Validation failures throw ValidationError, which carries a 400 status and the
// offending `field`. The one Express error middleware in index.js maps that to
// the `{ error: { message, field } }` response — no route handler formats errors.

export class ValidationError extends Error {
  constructor(message, field) {
    super(message)
    this.name = 'ValidationError'
    this.status = 400
    this.field = field
  }
}

export const STATUSES = ['active', 'pending', 'archived']

const NAME_MAX = 120
const NOTES_MAX = 1000

// Per-field validators return the normalized value or throw ValidationError.
// Create and update both go through these so "re-validates the same rules as
// create" is literally the same code, not a second copy that can drift.

// name: required, 1–120 chars. Trim first so a whitespace-only name is empty.
function validateName(value) {
  const name = typeof value === 'string' ? value.trim() : undefined
  if (!name) {
    throw new ValidationError('name is required', 'name')
  }
  if (name.length > NAME_MAX) {
    throw new ValidationError(`name must be ${NAME_MAX} characters or fewer`, 'name')
  }
  return name
}

// amount: required, finite, >= 0. Number.isFinite rejects NaN, ±Infinity, and
// non-number types in one check.
function validateAmount(value) {
  if (!Number.isFinite(value) || value < 0) {
    throw new ValidationError('amount must be a finite number greater than or equal to 0', 'amount')
  }
  return value
}

// status: required, one of the allowed values.
function validateStatus(value) {
  if (!STATUSES.includes(value)) {
    throw new ValidationError(`status must be one of ${STATUSES.join(', ')}`, 'status')
  }
  return value
}

// notes: <= 1000 chars, string only.
function validateNotes(value) {
  if (typeof value !== 'string') {
    throw new ValidationError('notes must be a string', 'notes')
  }
  if (value.length > NOTES_MAX) {
    throw new ValidationError(`notes must be ${NOTES_MAX} characters or fewer`, 'notes')
  }
  return value
}

// Validate and normalize an incoming create payload. Returns a clean object with
// ONLY the known fields — any client-supplied `id`/`_id` (or anything else) is
// dropped here rather than persisted. Timestamps are added by the data layer on
// insert, not here.
export function validateCreate(input) {
  const data = input ?? {}

  const clean = {
    name: validateName(data.name),
    status: validateStatus(data.status),
    amount: validateAmount(data.amount),
  }

  // notes: optional on create — a missing (or explicitly null) notes is simply
  // omitted; only a present string value is validated and kept.
  const { notes } = data
  if (notes !== undefined && notes !== null) {
    clean.notes = validateNotes(notes)
  }

  return clean
}

// Validate and normalize a partial update (PATCH) payload. Only the fields
// actually present are validated and returned, using the same per-field rules
// as create. Absent fields are left untouched by the caller. A `notes` of
// null/undefined is treated as "not provided" (mirroring create), not a request
// to clear it — clearing notes is out of scope for this contract.
const FIELD_VALIDATORS = {
  name: validateName,
  status: validateStatus,
  amount: validateAmount,
  notes: validateNotes,
}

export function validateUpdate(input) {
  const data = input ?? {}
  const clean = {}

  for (const [field, validate] of Object.entries(FIELD_VALIDATORS)) {
    if (!(field in data)) continue
    const value = data[field]
    // A notes explicitly set to null is skipped, consistent with create's
    // "optional" handling; any other present value is validated.
    if (value === undefined) continue
    if (field === 'notes' && value === null) continue
    clean[field] = validate(value)
  }

  return clean
}
