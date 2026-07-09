// Unit tests for the validation module — pure, no Mongo. Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { validateCreate, validateUpdate, ValidationError, STATUSES } from './schema.js'

const valid = { name: 'Widget', status: 'active', amount: 10, notes: 'a note' }

test('a valid payload returns a clean object with only known fields', () => {
  const clean = validateCreate(valid)
  assert.deepEqual(clean, { name: 'Widget', status: 'active', amount: 10, notes: 'a note' })
})

test('notes is optional and omitted from the clean object when absent', () => {
  const clean = validateCreate({ name: 'Widget', status: 'pending', amount: 0 })
  assert.deepEqual(clean, { name: 'Widget', status: 'pending', amount: 0 })
})

test('a client-supplied id/_id is stripped, not passed through', () => {
  const clean = validateCreate({ ...valid, id: 'abc', _id: 'def', extra: 'nope' })
  assert.deepEqual(Object.keys(clean).sort(), ['amount', 'name', 'notes', 'status'])
})

test('name is trimmed', () => {
  assert.equal(validateCreate({ ...valid, name: '  spaced  ' }).name, 'spaced')
})

test('amount 0 is accepted (>= 0, not > 0)', () => {
  assert.equal(validateCreate({ ...valid, amount: 0 }).amount, 0)
})

test('every allowed status validates', () => {
  for (const status of STATUSES) {
    assert.equal(validateCreate({ ...valid, status }).status, status)
  }
})

// Each rejection throws a ValidationError with status 400 and the offending field.
function assertRejects(input, field) {
  assert.throws(
    () => validateCreate(input),
    (err) => {
      assert.ok(err instanceof ValidationError, 'is a ValidationError')
      assert.equal(err.status, 400)
      assert.equal(err.field, field)
      assert.equal(typeof err.message, 'string')
      return true
    },
  )
}

test('missing name is rejected on field name', () => {
  assertRejects({ status: 'active', amount: 1 }, 'name')
})

test('empty / whitespace-only name is rejected on field name', () => {
  assertRejects({ ...valid, name: '' }, 'name')
  assertRejects({ ...valid, name: '   ' }, 'name')
})

test('name longer than 120 chars is rejected on field name', () => {
  assertRejects({ ...valid, name: 'x'.repeat(121) }, 'name')
})

test('negative amount is rejected on field amount', () => {
  assertRejects({ ...valid, amount: -1 }, 'amount')
})

test('non-finite amount (NaN, Infinity, non-number) is rejected on field amount', () => {
  assertRejects({ ...valid, amount: Number.NaN }, 'amount')
  assertRejects({ ...valid, amount: Number.POSITIVE_INFINITY }, 'amount')
  assertRejects({ ...valid, amount: '5' }, 'amount')
  assertRejects({ ...valid, amount: undefined }, 'amount')
})

test('status outside the allowed set is rejected on field status', () => {
  assertRejects({ ...valid, status: 'deleted' }, 'status')
  assertRejects({ name: 'x', amount: 1 }, 'status') // missing status
})

test('notes longer than 1000 chars is rejected on field notes', () => {
  assertRejects({ ...valid, notes: 'x'.repeat(1001) }, 'notes')
})

test('notes at exactly 1000 chars is accepted', () => {
  assert.equal(validateCreate({ ...valid, notes: 'x'.repeat(1000) }).notes.length, 1000)
})

// --- validateUpdate: partial payloads, same per-field rules as create ---

test('validateUpdate returns only the fields that are present', () => {
  assert.deepEqual(validateUpdate({ amount: 5 }), { amount: 5 })
  assert.deepEqual(validateUpdate({ name: 'Renamed', status: 'archived' }), {
    name: 'Renamed',
    status: 'archived',
  })
})

test('validateUpdate on an empty payload returns an empty object', () => {
  assert.deepEqual(validateUpdate({}), {})
  assert.deepEqual(validateUpdate(undefined), {})
})

test('validateUpdate normalizes present fields the same way create does', () => {
  assert.equal(validateUpdate({ name: '  spaced  ' }).name, 'spaced')
  assert.equal(validateUpdate({ amount: 0 }).amount, 0)
})

test('validateUpdate strips unknown fields, including id/_id', () => {
  assert.deepEqual(validateUpdate({ id: 'abc', _id: 'def', extra: 'nope', amount: 1 }), {
    amount: 1,
  })
})

test('validateUpdate re-validates each present field on its own field', () => {
  assertUpdateRejects({ name: '   ' }, 'name')
  assertUpdateRejects({ name: 'x'.repeat(121) }, 'name')
  assertUpdateRejects({ amount: -1 }, 'amount')
  assertUpdateRejects({ amount: 'nope' }, 'amount')
  assertUpdateRejects({ status: 'deleted' }, 'status')
  assertUpdateRejects({ notes: 'x'.repeat(1001) }, 'notes')
})

// A present notes of null/undefined is treated as "not provided", not a clear.
test('validateUpdate treats a null/undefined notes as absent', () => {
  assert.deepEqual(validateUpdate({ notes: null }), {})
  assert.deepEqual(validateUpdate({ notes: undefined }), {})
})

// Same rejection assertion as create, but driving validateUpdate.
function assertUpdateRejects(input, field) {
  assert.throws(
    () => validateUpdate(input),
    (err) => {
      assert.ok(err instanceof ValidationError, 'is a ValidationError')
      assert.equal(err.status, 400)
      assert.equal(err.field, field)
      assert.equal(typeof err.message, 'string')
      return true
    },
  )
}
