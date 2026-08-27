import { render, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { renderMarkdown } from './markdown.jsx'

// DAN-79: the internal markdown renderer. Every construct the ticket names,
// plus the sanitization guarantees: markdown becomes React elements only —
// no dangerouslySetInnerHTML — so HTML in the source is inert text, and only
// http/https/mailto/relative hrefs become anchors.

function renderMd(source) {
  return render(<div data-testid="md">{renderMarkdown(source)}</div>)
}

describe('DAN-79 · inline constructs', () => {
  it('renders **bold** as <strong>', () => {
    const { container } = renderMd('This is **important** stuff')
    const strong = container.querySelector('strong')
    expect(strong).toHaveTextContent('important')
    expect(container).toHaveTextContent('This is important stuff')
  })

  it('renders *italic* as <em>', () => {
    const { container } = renderMd('an *emphasised* word')
    expect(container.querySelector('em')).toHaveTextContent('emphasised')
  })

  it('nests italic inside bold', () => {
    const { container } = renderMd('**bold with *italic* inside**')
    const strong = container.querySelector('strong')
    expect(strong).toHaveTextContent('bold with italic inside')
    expect(strong.querySelector('em')).toHaveTextContent('italic')
  })

  it('renders `inline code` as <code>, its content literal', () => {
    const { container } = renderMd('run `npm **test**` locally')
    const code = container.querySelector('code')
    // Inside a code span, markdown syntax is literal — no nested <strong>.
    expect(code).toHaveTextContent('npm **test**')
    expect(code.querySelector('strong')).toBeNull()
  })

  it('renders [links](https://…) as anchors opening a new tab with rel="noopener noreferrer"', () => {
    const { getByRole } = renderMd('see [the docs](https://example.com/docs)')
    const link = getByRole('link', { name: 'the docs' })
    expect(link).toHaveAttribute('href', 'https://example.com/docs')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('allows http, mailto, and relative hrefs', () => {
    const { getByRole } = renderMd(
      '[a](http://example.com) [b](mailto:x@example.com) [c](/records)',
    )
    expect(getByRole('link', { name: 'a' })).toHaveAttribute(
      'href',
      'http://example.com',
    )
    expect(getByRole('link', { name: 'b' })).toHaveAttribute(
      'href',
      'mailto:x@example.com',
    )
    expect(getByRole('link', { name: 'c' })).toHaveAttribute('href', '/records')
  })
})

describe('DAN-79 · block constructs', () => {
  it('renders #, ##, ### as h1..h3', () => {
    const { getByRole } = renderMd('# Title\n## Section\n### Detail')
    expect(getByRole('heading', { level: 1 })).toHaveTextContent('Title')
    expect(getByRole('heading', { level: 2 })).toHaveTextContent('Section')
    expect(getByRole('heading', { level: 3 })).toHaveTextContent('Detail')
  })

  it('leaves deeper-than-### hashes as plain paragraph text', () => {
    const { container, queryByRole } = renderMd('#### not a heading')
    expect(queryByRole('heading')).toBeNull()
    expect(container).toHaveTextContent('#### not a heading')
  })

  it('groups consecutive "- " lines into one <ul>', () => {
    const { container } = renderMd('- first\n- second\n- third')
    const lists = container.querySelectorAll('ul')
    expect(lists).toHaveLength(1)
    const items = within(lists[0]).getAllByRole('listitem')
    expect(items.map((li) => li.textContent)).toEqual([
      'first',
      'second',
      'third',
    ])
  })

  it('groups consecutive "1. " lines into one <ol>', () => {
    const { container } = renderMd('1. plan\n2. build\n3. test')
    const lists = container.querySelectorAll('ol')
    expect(lists).toHaveLength(1)
    expect(
      within(lists[0])
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['plan', 'build', 'test'])
  })

  it('renders list items with inline markdown inside', () => {
    const { container } = renderMd('- **bold** item')
    expect(container.querySelector('li strong')).toHaveTextContent('bold')
  })

  it('renders fenced code blocks as <pre><code> with literal content', () => {
    const { container } = renderMd(
      'Before\n```js\nconst x = 1\n**not bold**\n```\nAfter',
    )
    const pre = container.querySelector('pre')
    expect(pre).not.toBeNull()
    expect(pre.textContent).toBe('const x = 1\n**not bold**')
    expect(pre.querySelector('strong')).toBeNull()
    expect(container).toHaveTextContent('Before')
    expect(container).toHaveTextContent('After')
  })

  it('treats an unclosed fence as running to end of input (mid-reveal shape)', () => {
    const { container } = renderMd('```\nhalf-arrived')
    expect(container.querySelector('pre').textContent).toBe('half-arrived')
  })

  it('splits paragraphs on blank lines', () => {
    const { container } = renderMd('one\n\ntwo')
    const paras = container.querySelectorAll('p')
    expect(paras).toHaveLength(2)
    expect(paras[0]).toHaveTextContent('one')
    expect(paras[1]).toHaveTextContent('two')
  })
})

describe('DAN-79 · sanitization', () => {
  it('renders <script> (and any HTML) as inert literal text', () => {
    const { container } = renderMd(
      'try this: <script>alert(1)</script> <img src=x onerror=alert(1)>',
    )
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    // The characters render literally for the user to see.
    expect(container).toHaveTextContent('<script>alert(1)</script>')
  })

  it('renders javascript: links as plain text, not anchors', () => {
    const { container, queryByRole } = renderMd(
      'click [here](javascript:alert(1))',
    )
    expect(queryByRole('link')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
    expect(container).toHaveTextContent('[here](javascript:alert(1))')
  })

  it('renders data: and other schemes as plain text too', () => {
    const { container } = renderMd(
      '[a](data:text/html,x) [b](vbscript:x) [c](JaVaScRiPt:alert(1))',
    )
    expect(container.querySelector('a')).toBeNull()
  })
})
