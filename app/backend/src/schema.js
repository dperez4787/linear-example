// The single source of truth for Record validation. Applied on create here and
// (in a later ticket) on update. The frontend may mirror these rules for UX but
// is never the enforcement point — see docs/architecture.md.
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

// Validate and normalize an incoming create payload. Returns a clean object with
// ONLY the known fields — any client-supplied `id`/`_id` (or anything else) is
// dropped here rather than persisted. Timestamps are added by the data layer on
// insert, not here.
export function validateCreate(input) {
  const data = input ?? {}

  // name: required, 1–120 chars. Trim first so a whitespace-only name is empty.
  const name = typeof data.name === 'string' ? data.name.trim() : undefined
  if (!name) {
    throw new ValidationError('name is required', 'name')
  }
  if (name.length > NAME_MAX) {
    throw new ValidationError(`name must be ${NAME_MAX} characters or fewer`, 'name')
  }

  // amount: required, finite, >= 0. Number.isFinite rejects NaN and ±Infinity
  // and non-number types in one check.
  const { amount } = data
  if (!Number.isFinite(amount) || amount < 0) {
    throw new ValidationError('amount must be a finite number greater than or equal to 0', 'amount')
  }

  // status: required, one of the allowed values.
  const { status } = data
  if (!STATUSES.includes(status)) {
    throw new ValidationError(`status must be one of ${STATUSES.join(', ')}`, 'status')
  }

  // notes: optional, <= 1000 chars when present.
  const { notes } = data
  if (notes !== undefined && notes !== null) {
    if (typeof notes !== 'string') {
      throw new ValidationError('notes must be a string', 'notes')
    }
    if (notes.length > NOTES_MAX) {
      throw new ValidationError(`notes must be ${NOTES_MAX} characters or fewer`, 'notes')
    }
  }

  const clean = { name, status, amount }
  if (typeof notes === 'string') clean.notes = notes
  return clean
}
