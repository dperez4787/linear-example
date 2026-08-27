// sanitizeTitle (DAN-90): the model's reply is NEVER trusted for formatting.
// Whatever the titler emits — fences, labels, Title Case, hyphens, emoji, a
// paragraph — either sanitizes to a slug matching TITLE_PATTERN or comes back
// null so the caller falls back to the DAN-88 truncated project name.
//
// Pure unit tests: no Mongo, no gateway, no app. Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  sanitizeTitle,
  TITLE_PATTERN,
  TITLE_MAX_CHARS,
  TITLE_MAX_WORDS,
  TITLE_MODEL,
  MAX_TOKENS_BY_ROLE,
} from './featureRequests.js'

// Every non-null result must satisfy the contract, whatever the input was.
function assertSlug(slug) {
  assert.equal(typeof slug, 'string')
  assert.match(slug, TITLE_PATTERN, `"${slug}" must match ${TITLE_PATTERN}`)
  assert.ok(slug.length <= TITLE_MAX_CHARS, `"${slug}" must be <= ${TITLE_MAX_CHARS} chars`)
  assert.ok(
    slug.split('_').length <= TITLE_MAX_WORDS,
    `"${slug}" must be <= ${TITLE_MAX_WORDS} words`,
  )
}

// --- the happy path ---

test('an already-clean slug passes through unchanged', () => {
  const slug = sanitizeTitle('change_buttons_to_green')
  assert.equal(slug, 'change_buttons_to_green')
  assertSlug(slug)
})

test('surrounding whitespace and a trailing newline are trimmed', () => {
  assert.equal(sanitizeTitle('  \n change_buttons_to_green \n\n'), 'change_buttons_to_green')
})

// --- adversarial model output (the ticket's list, one test each) ---

test('double quotes are stripped', () => {
  const slug = sanitizeTitle('"change_buttons_to_green"')
  assert.equal(slug, 'change_buttons_to_green')
  assertSlug(slug)
})

test('single quotes and backticks are stripped', () => {
  assert.equal(sanitizeTitle("'change_buttons_to_green'"), 'change_buttons_to_green')
  assert.equal(sanitizeTitle('`change_buttons_to_green`'), 'change_buttons_to_green')
})

test('a markdown code fence is unwrapped', () => {
  const slug = sanitizeTitle('```\nchange_buttons_to_green\n```')
  assert.equal(slug, 'change_buttons_to_green')
  assertSlug(slug)
})

test('a language-tagged code fence is unwrapped', () => {
  assert.equal(
    sanitizeTitle('```text\nchange_buttons_to_green\n```'),
    'change_buttons_to_green',
  )
})

test('a "Title: ..." preamble is dropped, not turned into the first word', () => {
  const slug = sanitizeTitle('Title: change buttons to green')
  assert.equal(slug, 'change_buttons_to_green')
  assert.ok(!slug.startsWith('title_'), 'the label must not survive as a word')
})

test('a bolded markdown label preamble is dropped', () => {
  assert.equal(sanitizeTitle('**Slug:** change_buttons_to_green'), 'change_buttons_to_green')
})

test('Title Case with spaces becomes lowercase underscores', () => {
  const slug = sanitizeTitle('Change Buttons To Green')
  assert.equal(slug, 'change_buttons_to_green')
  assertSlug(slug)
})

test('hyphens become underscores', () => {
  assert.equal(sanitizeTitle('change-buttons-to-green'), 'change_buttons_to_green')
})

test('an em-dash between words separates rather than glues them', () => {
  assert.equal(sanitizeTitle('change—buttons—to—green'), 'change_buttons_to_green')
})

test('emoji are stripped and the surrounding words survive', () => {
  const slug = sanitizeTitle('🚀 change buttons to green ✨')
  assert.equal(slug, 'change_buttons_to_green')
  assertSlug(slug)
})

test('an all-emoji reply is unusable → null', () => {
  assert.equal(sanitizeTitle('🚀✨🎉'), null)
})

test('CJK is stripped; an all-CJK reply is unusable → null', () => {
  assert.equal(sanitizeTitle('把按钮改成绿色'), null)
  assert.equal(sanitizeTitle('把按钮 change_buttons 改成绿色'), 'change_buttons')
})

test('a 200-char ramble is capped at 5 words and 50 chars, never mid-word', () => {
  const ramble =
    'Sure! Here is a great snake_case title for this particular feature request that the user has been describing at some length in the conversation above, which concerns changing the color of several buttons.'
  assert.ok(ramble.length >= 200, 'fixture is actually a long ramble')
  const slug = sanitizeTitle(ramble)
  assertSlug(slug)
  assert.equal(slug, 'sure_here_is_a_great')
  assert.ok(!slug.endsWith('_'), 'never ends on a separator')
})

test('leading and trailing punctuation is stripped', () => {
  assertSlug(sanitizeTitle('...change_buttons_to_green!!!'))
  assert.equal(sanitizeTitle('...change_buttons_to_green!!!'), 'change_buttons_to_green')
  assert.equal(sanitizeTitle('-- change buttons --'), 'change_buttons')
  assert.equal(sanitizeTitle('#[(change_buttons)]#'), 'change_buttons')
})

test('the empty string is unusable → null', () => {
  assert.equal(sanitizeTitle(''), null)
  assert.equal(sanitizeTitle('   \n\t  '), null)
})

test('punctuation-only output is unusable → null', () => {
  assert.equal(sanitizeTitle('---'), null)
  assert.equal(sanitizeTitle('___'), null)
  assert.equal(sanitizeTitle('"..."'), null)
})

test('multi-line output keeps the first non-empty line', () => {
  const slug = sanitizeTitle(
    '\n\nchange_buttons_to_green\n\nThis title captures the request to revert the button color.',
  )
  assert.equal(slug, 'change_buttons_to_green')
  assertSlug(slug)
})

test('multi-line output whose first line is a label still yields the slug', () => {
  assert.equal(
    sanitizeTitle('Title: change_buttons_to_green\nLet me know if you want another.'),
    'change_buttons_to_green',
  )
})

test('non-string model output is unusable → null', () => {
  for (const value of [null, undefined, 42, {}, [], true]) {
    assert.equal(sanitizeTitle(value), null, `${JSON.stringify(value) ?? 'undefined'} → null`)
  }
})

// --- the caps, explicitly ---

test('repeated underscores collapse and edge underscores are trimmed', () => {
  assert.equal(sanitizeTitle('__change___buttons__to_green__'), 'change_buttons_to_green')
})

test('more than 5 words are truncated to exactly 5', () => {
  const slug = sanitizeTitle('one two three four five six seven eight')
  assert.equal(slug, 'one_two_three_four_five')
  assertSlug(slug)
})

test('a long 5-word slug drops WHOLE trailing words to fit 50 chars', () => {
  // 5 x 11-char words + 4 underscores = 59 > 50; dropping one word gives 47.
  const slug = sanitizeTitle('abcdefghijk abcdefghijk abcdefghijk abcdefghijk abcdefghijk')
  assertSlug(slug)
  assert.equal(slug.split('_').length, 4, 'a whole word was dropped, not a fragment')
  assert.equal(slug, 'abcdefghijk_abcdefghijk_abcdefghijk_abcdefghijk')
})

test('a single word longer than the cap is cut to the cap (the only mid-word cut)', () => {
  const slug = sanitizeTitle('z'.repeat(120))
  assertSlug(slug)
  assert.equal(slug, 'z'.repeat(TITLE_MAX_CHARS))
})

test('a very long first word followed by others still fits the cap', () => {
  const slug = sanitizeTitle(`${'z'.repeat(80)} tail`)
  assertSlug(slug)
  assert.equal(slug, 'z'.repeat(TITLE_MAX_CHARS))
})

// --- the role constants the gateway call is built from ---

test('the titler runs on the cheap model with a small explicit budget', () => {
  assert.equal(TITLE_MODEL, 'claude-haiku-4-5')
  assert.equal(MAX_TOKENS_BY_ROLE.titler, 40)
})

test('the title budget leaves the 80-char Linear project name cap intact', () => {
  // 'paf: ' is 5 characters; the module refuses to load if this ever breaks.
  assert.ok(5 + TITLE_MAX_CHARS <= 80)
})
