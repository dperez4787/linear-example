// projectName (DAN-88): the Linear project name must never exceed Linear's
// 80-character projectCreate cap — INCLUDING the 'paf: ' prefix and the
// trailing ellipsis. The old code truncated the base to 80 and THEN prepended
// the prefix (total 85), so approve failed with INTERNAL for long prompts.
// Pure unit tests — no Mongo, no app; run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { projectName } from './featureRequests.js'

const PREFIX = 'paf: '
const MAX = 80
const BASE_BUDGET = MAX - PREFIX.length // 75

const doc = (content) => ({
  messages: [{ role: 'user', content, createdAt: new Date() }],
  _id: { toString: () => 'aaaaaaaaaaaaaaaaaaaaaaaa' },
})

test('a short message is passed through untouched (no churn for existing fits)', () => {
  const name = projectName(doc('Please add a CSV export of the records table'))
  assert.equal(name, 'paf: Please add a CSV export of the records table')
})

test('a message that exactly fits with the prefix is not truncated — total exactly 80', () => {
  const msg = 'a'.repeat(BASE_BUDGET)
  const name = projectName(doc(msg))
  assert.equal(name, `${PREFIX}${msg}`)
  assert.equal(name.length, MAX)
  assert.ok(!name.endsWith('…'), 'an exact fit gains no ellipsis')
})

test('one character over the fit is truncated to exactly 80 with a trailing ellipsis', () => {
  const msg = 'a'.repeat(BASE_BUDGET + 1)
  const name = projectName(doc(msg))
  assert.equal(name.length, MAX)
  assert.ok(name.endsWith('…'))
  assert.equal(name, `${PREFIX}${'a'.repeat(BASE_BUDGET - 1)}…`)
})

test('a very long message yields a name of at most 80 chars ending with an ellipsis', () => {
  const name = projectName(doc('add a feature that '.repeat(50)))
  assert.ok(name.length <= MAX, `name.length ${name.length} exceeds ${MAX}`)
  assert.ok(name.startsWith(PREFIX))
  assert.ok(name.endsWith('…'))
})

test('an emoji straddling the cut point is dropped whole — no broken surrogate pair', () => {
  // 73 ASCII chars, then emoji (2 UTF-16 units each): the naive cut at
  // BASE_BUDGET - 1 = 74 would land between the surrogates of the first emoji.
  const msg = `${'a'.repeat(73)}😀😀😀`
  const name = projectName(doc(msg))
  assert.ok(name.length <= MAX)
  assert.ok(name.endsWith('…'))
  assert.ok(name.isWellFormed(), 'no lone surrogate anywhere in the name')
  assert.equal(name, `${PREFIX}${'a'.repeat(73)}…`)
})

test('an emoji fully inside the cut survives intact', () => {
  const msg = `${'a'.repeat(70)}😀${'b'.repeat(20)}`
  const name = projectName(doc(msg))
  assert.ok(name.length <= MAX)
  assert.ok(name.isWellFormed())
  assert.ok(name.includes('😀'))
  assert.ok(name.endsWith('…'))
})

test('the _id fallback (no user message) is used and respects the bound', () => {
  const short = { messages: [], _id: { toString: () => 'aaaaaaaaaaaaaaaaaaaaaaaa' } }
  assert.equal(projectName(short), 'paf: aaaaaaaaaaaaaaaaaaaaaaaa')

  const long = { messages: [], _id: { toString: () => 'f'.repeat(200) } }
  const name = projectName(long)
  assert.equal(name.length, MAX)
  assert.ok(name.endsWith('…'))
})
