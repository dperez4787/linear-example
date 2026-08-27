import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import FeatureRequestView from './FeatureRequestView.jsx'
import { renderMarkdown } from './markdown.jsx'
import {
  sendFeatureRequestMessage,
  startFeatureRequest,
} from './api.js'

// DAN-79 — independent tester suite (written from the acceptance criteria,
// not from the developer's tests).
//
// Criteria under test:
//   1. Assistant messages render markdown (bold, italic, lists, headings,
//      inline code, fenced code, links with target=_blank + rel=noopener) as
//      real React-produced DOM elements; user messages stay plain text.
//   2. No dangerouslySetInnerHTML anywhere in src/; malicious input
//      (<script>, javascript:/data: links) is inert.
//   3. New replies type on progressively; clicking the bubble completes
//      instantly; prefers-reduced-motion renders instantly; completed
//      replies never replay on later re-renders; environments without
//      matchMedia render complete immediately.
//   4. The parser never throws on adversarial input.

vi.mock('./api.js', () => ({
  startFeatureRequest: vi.fn(),
  sendFeatureRequestMessage: vi.fn(),
  featureRequest: vi.fn(),
  featureRequestProgress: vi.fn(),
  myAiUsage: vi.fn(async () => undefined),
  approveFeatureRequestPlan: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

function requestWith(messages) {
  return {
    id: 'fr-tester',
    status: 'open',
    model: 'claude-opus-5',
    createdAt: '2026-08-27T12:00:00.000Z',
    messages,
    entranceCriteria: null,
    approvable: false,
  }
}

// Drive one full user->server round: type, send, resolve the server reply
// with the given canonical transcript.
async function driveRound(text, transcriptAfter) {
  let release
  const gate = new Promise((res) => {
    release = res
  })
  vi.mocked(startFeatureRequest).mockResolvedValue(requestWith([]))
  vi.mocked(sendFeatureRequestMessage).mockReturnValueOnce(gate)
  fireEvent.change(screen.getByLabelText('Message'), {
    target: { value: text },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await act(async () => {
    release(requestWith(transcriptAfter))
  })
}

// The transcript's direct <li> children — NOT getAllByRole('listitem'),
// which would also pick up <li>s of markdown lists inside a reply.
function transcriptBubbles() {
  return [
    ...screen.getByRole('list', { name: 'Conversation' }).children,
  ]
}

function bubbleContent(bubble) {
  return bubble.querySelector('.chat-message__content')
}

function installMatchMedia(reduced) {
  window.matchMedia = vi.fn((query) => ({
    matches: reduced && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }))
}

beforeEach(() => {
  vi.mocked(startFeatureRequest).mockReset()
  vi.mocked(sendFeatureRequestMessage).mockReset()
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  vi.useRealTimers()
  delete Element.prototype.scrollIntoView
  delete window.matchMedia
})

// ---------------------------------------------------------------------------
// 1. The renderer: every construct becomes a real element
// ---------------------------------------------------------------------------

function mount(source) {
  return render(<div data-testid="root">{renderMarkdown(source)}</div>)
}

describe('DAN-79 tester · renderMarkdown constructs', () => {
  it('bold -> <strong>, italic -> <em>', () => {
    const { container } = mount('a **loud** and a *quiet* word')
    expect(container.querySelector('strong')).toHaveTextContent('loud')
    expect(container.querySelector('em')).toHaveTextContent('quiet')
    // The delimiters themselves are consumed, not shown.
    expect(container.textContent).toBe('a loud and a quiet word')
  })

  it('headings # ## ### -> h1/h2/h3 with inline markdown honoured inside', () => {
    const { getByRole } = mount('# One\n## Two **bold**\n### Three')
    expect(getByRole('heading', { level: 1 })).toHaveTextContent('One')
    const h2 = getByRole('heading', { level: 2 })
    expect(h2).toHaveTextContent('Two bold')
    expect(h2.querySelector('strong')).toHaveTextContent('bold')
    expect(getByRole('heading', { level: 3 })).toHaveTextContent('Three')
  })

  it('bullet runs -> a single <ul> of <li>; numbered runs -> a single <ol>', () => {
    const { container } = mount(
      '- alpha\n- beta\n\n1. uno\n2. dos\n3. tres',
    )
    const uls = container.querySelectorAll('ul')
    const ols = container.querySelectorAll('ol')
    expect(uls).toHaveLength(1)
    expect(ols).toHaveLength(1)
    expect(
      [...uls[0].querySelectorAll('li')].map((li) => li.textContent),
    ).toEqual(['alpha', 'beta'])
    expect(
      [...ols[0].querySelectorAll('li')].map((li) => li.textContent),
    ).toEqual(['uno', 'dos', 'tres'])
  })

  it('inline code -> <code> with literal (unparsed) content', () => {
    const { container } = mount('call `render(**x**)` twice')
    const code = container.querySelector('code')
    expect(code.textContent).toBe('render(**x**)')
    expect(code.querySelector('strong')).toBeNull()
  })

  it('fenced block -> <pre><code>, contents literal, no markdown applied', () => {
    const { container } = mount(
      'intro\n```python\n# not a heading\n**not bold**\n```\noutro',
    )
    const pre = container.querySelector('pre')
    expect(pre).not.toBeNull()
    expect(pre.textContent).toContain('# not a heading')
    expect(pre.textContent).toContain('**not bold**')
    expect(pre.querySelector('strong')).toBeNull()
    expect(container.querySelector('h1')).toBeNull()
  })

  it('links -> <a> with href, target=_blank and rel containing noopener', () => {
    const { getByRole } = mount('read [the guide](https://example.org/guide)')
    const a = getByRole('link', { name: 'the guide' })
    expect(a.getAttribute('href')).toBe('https://example.org/guide')
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toContain('noopener')
  })

  it('http, mailto and relative hrefs are all allowed', () => {
    const { container } = mount(
      '[h](http://example.org) [m](mailto:a@b.c) [r](/relative/path) [f](#frag)',
    )
    const hrefs = [...container.querySelectorAll('a')].map((a) =>
      a.getAttribute('href'),
    )
    expect(hrefs).toEqual([
      'http://example.org',
      'mailto:a@b.c',
      '/relative/path',
      '#frag',
    ])
  })
})

// ---------------------------------------------------------------------------
// 2. Sanitization
// ---------------------------------------------------------------------------

describe('DAN-79 tester · sanitization', () => {
  it('<script> input never becomes a script element; the text stays visible', () => {
    const { container } = mount('hi <script>alert(1)</script> there')
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('<script>alert(1)</script>')
  })

  it('event-handler-shaped HTML is inert text as well', () => {
    const { container } = mount('<img src=x onerror=alert(1)><b onclick=x>y</b>')
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
  })

  it('javascript: links never become anchors (plain and percent-encoded)', () => {
    const cases = [
      '[x](javascript:alert(1))',
      '[x](javascript:alert%281%29)',
      '[x](JavaScript:alert%281%29)',
    ]
    for (const source of cases) {
      const { container, unmount } = mount(source)
      expect(container.querySelector('a'), source).toBeNull()
      unmount()
    }
  })

  it('data: and vbscript: links never become anchors', () => {
    const { container } = mount(
      '[d](data:text/html;base64,PHNjcmlwdD4=) [v](vbscript:msgbox) [D](DATA:text/html,x)',
    )
    expect(container.querySelector('a')).toBeNull()
  })

  it('dangerouslySetInnerHTML is used nowhere under src/', () => {
    const srcDir = path.dirname(fileURLToPath(import.meta.url))
    const offenders = []
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
        } else if (/\.(jsx?|tsx?)$/.test(entry.name)) {
          const text = fs.readFileSync(full, 'utf8')
          // Match actual usage (a JSX prop or object key), so prose comments
          // that merely mention the name don't trip the sweep.
          if (/dangerouslySetInnerHTML\s*[=:]/.test(text)) {
            offenders.push(full)
          }
        }
      }
    }
    walk(srcDir)
    expect(offenders).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 3. Adversarial parser input — must never throw
// ---------------------------------------------------------------------------

describe('DAN-79 tester · parser robustness', () => {
  const hostile = [
    ['empty string', ''],
    ['null-ish', undefined],
    ['unclosed fence', '```\nstill open, never closed'],
    ['fence only', '```'],
    ['unclosed bold', '**never closed'],
    ['unclosed link', '[label](https://example.org'],
    ['bare brackets', '[]() [ ] ( )'],
    ['nested bold in link', '[**bold label**](https://example.org)'],
    ['link in bold', '**see [x](https://example.org) now**'],
    ['very long single line', `start ${'y'.repeat(20000)} end`],
    ['long asterisk run', '*'.repeat(3000)],
    ['long backtick run', '`'.repeat(3000)],
    ['long bracket run', '['.repeat(2000) + ']('.repeat(2000)],
    ['blank lines only', '\n\n\n\n'],
  ]

  it.each(hostile)('does not throw on %s', (_name, source) => {
    expect(() => {
      const { unmount } = mount(source)
      unmount()
    }).not.toThrow()
  })

  it('nested bold inside a link renders as strong inside the anchor', () => {
    const { container } = mount('[**bold label**](https://example.org)')
    const a = container.querySelector('a')
    expect(a).not.toBeNull()
    expect(a.querySelector('strong')).toHaveTextContent('bold label')
  })

  it('a very long single line round-trips its text content', () => {
    const long = `start ${'y'.repeat(20000)} end`
    const { container } = mount(long)
    expect(container.textContent).toBe(long)
  })
})

// ---------------------------------------------------------------------------
// 4. In the chat: assistant bubbles are markdown, user bubbles are plain
// ---------------------------------------------------------------------------

describe('DAN-79 tester · transcript rendering (no matchMedia -> instant)', () => {
  it('an assistant reply renders as elements; jsdom without matchMedia never animates', async () => {
    render(<FeatureRequestView onBack={() => {}} />)
    await driveRound('please plan it', [
      { role: 'user', content: 'please plan it' },
      {
        role: 'architect',
        content:
          '# Approach\n**Stream** the data.\n- keep `memory` low\n1. write\n2. flush\n```\npipe(src, dst)\n```\n[spec](https://example.org/spec)',
      },
    ])

    const reply = transcriptBubbles()[1]
    // No timers were advanced and no matchMedia exists: the full reply must
    // already be there (the historical/no-animation-environment guarantee).
    expect(within(reply).getByRole('heading', { level: 1 })).toHaveTextContent(
      'Approach',
    )
    expect(reply.querySelector('strong')).toHaveTextContent('Stream')
    expect(reply.querySelector('ul li')).toHaveTextContent('keep memory low')
    expect(reply.querySelector('ul li code')).toHaveTextContent('memory')
    expect(
      [...reply.querySelectorAll('ol li')].map((li) => li.textContent),
    ).toEqual(['write', 'flush'])
    expect(reply.querySelector('pre').textContent).toContain('pipe(src, dst)')
    const a = within(reply).getByRole('link', { name: 'spec' })
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toContain('noopener')
  })

  it('the user bubble keeps markdown syntax literal — no elements produced', async () => {
    render(<FeatureRequestView onBack={() => {}} />)
    const raw = '# not a heading **not bold** [not a link](https://x)'
    await driveRound(raw, [
      { role: 'user', content: raw },
      { role: 'product-owner', content: 'noted' },
    ])

    const userBubble = transcriptBubbles()[0]
    expect(within(userBubble).getByText('user')).toBeInTheDocument()
    expect(userBubble.querySelector('strong')).toBeNull()
    expect(userBubble.querySelector('a')).toBeNull()
    expect(userBubble.querySelector('h1')).toBeNull()
    expect(bubbleContent(userBubble).textContent).toBe(raw)
  })

  it('a malicious assistant reply is inert inside the bubble', async () => {
    render(<FeatureRequestView onBack={() => {}} />)
    await driveRound('hello', [
      { role: 'user', content: 'hello' },
      {
        role: 'product-owner',
        content:
          '<script>alert(1)</script>\n[go](javascript:alert%281%29) [d](data:text/html,x)',
      },
    ])

    const reply = transcriptBubbles()[1]
    expect(reply.querySelector('script')).toBeNull()
    expect(reply.querySelector('a')).toBeNull()
    expect(reply.textContent).toContain('<script>alert(1)</script>')
  })
})

// ---------------------------------------------------------------------------
// 5. Typewriter reveal
// ---------------------------------------------------------------------------

describe('DAN-79 tester · typewriter reveal', () => {
  // 150 plain characters: no markdown, so revealed text length maps 1:1 to
  // revealed characters and progression is measurable.
  const reply =
    'We will stream the export from the backend in fixed-size chunks so that ' +
    'the browser never has to hold the entire file in memory at once ok'

  function renderAnimated({ reduced = false } = {}) {
    installMatchMedia(reduced)
    vi.useFakeTimers()
    render(<FeatureRequestView onBack={() => {}} />)
  }

  async function oneRound() {
    await driveRound('export please', [
      { role: 'user', content: 'export please' },
      { role: 'product-owner', content: reply },
    ])
  }

  it('reveals progressively: strictly growing prefixes of the reply across ticks', async () => {
    renderAnimated()
    await oneRound()

    const content = bubbleContent(transcriptBubbles()[1])
    // Before any tick: bubble exists, nothing revealed yet.
    expect(content.textContent).toBe('')

    act(() => {
      vi.advanceTimersByTime(25)
    })
    const afterOneTick = content.textContent
    expect(afterOneTick.length).toBeGreaterThan(0)
    expect(afterOneTick.length).toBeLessThan(reply.length)
    expect(reply.startsWith(afterOneTick)).toBe(true)

    act(() => {
      vi.advanceTimersByTime(25)
    })
    const afterTwoTicks = content.textContent
    expect(afterTwoTicks.length).toBeGreaterThan(afterOneTick.length)
    expect(afterTwoTicks.length).toBeLessThan(reply.length)
    expect(reply.startsWith(afterTwoTicks)).toBe(true)

    // Enough time for the rest: complete, exactly once, no overshoot.
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(content.textContent).toBe(reply)
  })

  it('pace is roughly 1000 chars/sec (25 chars per 25ms tick)', async () => {
    renderAnimated()
    await oneRound()
    const content = bubbleContent(transcriptBubbles()[1])
    act(() => {
      vi.advanceTimersByTime(100)
    })
    // 4 ticks x 25 chars: allow one tick of slack either way.
    expect(content.textContent.length).toBeGreaterThanOrEqual(75)
    expect(content.textContent.length).toBeLessThanOrEqual(125)
  })

  it('clicking the bubble completes the reveal instantly and it stays complete', async () => {
    renderAnimated()
    await oneRound()

    const bubble = transcriptBubbles()[1]
    act(() => {
      vi.advanceTimersByTime(25)
    })
    expect(bubbleContent(bubble).textContent).not.toBe(reply)

    fireEvent.click(bubble)
    expect(bubbleContent(bubble).textContent).toBe(reply)

    // No restart, no truncation on subsequent ticks.
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(bubbleContent(bubble).textContent).toBe(reply)
  })

  it('prefers-reduced-motion: reduce renders the reply complete with zero ticks', async () => {
    renderAnimated({ reduced: true })
    await oneRound()
    expect(bubbleContent(transcriptBubbles()[1]).textContent).toBe(reply)
  })

  it('a finished reply never replays while a later reply animates', async () => {
    renderAnimated()
    await oneRound()
    act(() => {
      vi.advanceTimersByTime(10000)
    })
    expect(bubbleContent(transcriptBubbles()[1]).textContent).toBe(reply)

    const second = 'Second answer: yes, the same chunked stream can serve it.'
    await driveRound('and excel?', [
      { role: 'user', content: 'export please' },
      { role: 'product-owner', content: reply },
      { role: 'user', content: 'and excel?' },
      { role: 'architect', content: second },
    ])

    // Zero ticks after the new transcript: the old reply is still complete
    // (no replay), the new one has not typed yet.
    const bubblesNow = transcriptBubbles()
    expect(bubbleContent(bubblesNow[1]).textContent).toBe(reply)
    expect(bubbleContent(bubblesNow[3]).textContent).toBe('')

    act(() => {
      vi.advanceTimersByTime(10000)
    })
    expect(bubbleContent(transcriptBubbles()[1]).textContent).toBe(reply)
    expect(bubbleContent(transcriptBubbles()[3]).textContent).toBe(second)
  })

  it('mid-reveal markdown is safe: an unclosed fence mid-type renders as a growing code block', async () => {
    renderAnimated()
    await driveRound('code please', [
      { role: 'user', content: 'code please' },
      {
        role: 'architect',
        content: '```\n' + 'const a = 1\nconst b = 2\nconst c = 3\n' + '```',
      },
    ])
    const bubble = transcriptBubbles()[1]
    act(() => {
      vi.advanceTimersByTime(25) // 25 chars: fence + partial body, no close
    })
    const pre = bubble.querySelector('pre')
    expect(pre).not.toBeNull()
    expect(pre.textContent).toContain('const a = 1')
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(bubble.querySelector('pre').textContent).toContain('const c = 3')
  })
})
