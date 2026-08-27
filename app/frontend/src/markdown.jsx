// DAN-79: a deliberately small internal markdown renderer for the chat's
// agent replies. The agents (product-owner, architect) answer in markdown —
// bold, lists, headings, code — which DAN-53's plain-text bubbles showed as
// raw asterisks and hashes.
//
// Why not a dependency: the surface we need is tiny (six inline/block
// constructs), and a hand-rolled parser that only ever emits React elements
// is structurally immune to HTML injection — there is no
// dangerouslySetInnerHTML anywhere, so `<script>` in a reply is just a text
// node and renders as the literal characters. Link hrefs are the one place
// markdown can smuggle an active payload, so they pass an allowlist
// (http/https/mailto, plus bare relative paths); any other scheme —
// javascript:, data:, vbscript: — renders the raw source text instead of an
// anchor, inert and visible.
//
// Two passes, matching how markdown is actually shaped:
//   1. a line-based block pass — fenced code, #..### headings, `-`/`*` and
//      `1.` list grouping, paragraphs (blank-line separated),
//   2. an inline pass within each block — code spans first (their content is
//      literal, so they win ties by source order), then bold, italic, links.
// Anything the parser does not recognise falls through as plain text; it
// never throws on malformed input.

// One regex, alternation ordered by precedence at equal start positions:
// code span | bold | italic | link. The global scan is left-to-right, so an
// earlier construct always wins; at the same index a code span beats bold
// beats italic (i.e. `**x**` is bold, not an italic of `*x*`).
const INLINE_PATTERN =
  /(`+)([^`]*?)\1|\*\*((?:[^*]|\*(?!\*))+?)\*\*|\*([^*\n]+?)\*|\[([^\]\n]*)\]\(([^()\s]+)\)/g

// Hrefs an anchor may carry. Explicit schemes are allowlisted; a
// scheme-looking prefix outside the allowlist (javascript:, data:, …) is
// rejected. Anything without a scheme (relative paths, #anchors,
// protocol-relative //host) resolves against the page's own http(s) origin
// and is safe by construction.
function isSafeHref(href) {
  if (/^(https?:|mailto:)/i.test(href)) return true
  return !/^[a-z][a-z0-9+.-]*:/i.test(href)
}

// Inline pass: text -> array of strings and React elements. Recurses into
// bold/italic/link labels so `**bold with *italic***` nests; code span
// content stays literal.
function renderInline(text, keyPrefix = 'i') {
  const nodes = []
  let last = 0
  let key = 0
  INLINE_PATTERN.lastIndex = 0
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const [source, , code, bold, italic, linkLabel, linkHref] = match
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const k = `${keyPrefix}-${key++}`
    if (code !== undefined) {
      nodes.push(<code key={k}>{code}</code>)
    } else if (bold !== undefined) {
      nodes.push(<strong key={k}>{renderInline(bold, k)}</strong>)
    } else if (italic !== undefined) {
      nodes.push(<em key={k}>{renderInline(italic, k)}</em>)
    } else if (isSafeHref(linkHref)) {
      nodes.push(
        <a key={k} href={linkHref} target="_blank" rel="noopener noreferrer">
          {renderInline(linkLabel, k)}
        </a>,
      )
    } else {
      // Unsafe scheme: the raw `[label](href)` source renders as plain text —
      // visible, attributable, and inert. Never an anchor.
      nodes.push(source)
    }
    last = match.index + source.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

const HEADING_PATTERN = /^(#{1,3}) (.*)$/
const UNORDERED_ITEM = /^[-*] (.*)$/
const ORDERED_ITEM = /^\d+\. (.*)$/
const FENCE = /^```/

// Paragraph lines keep their line breaks as <br /> elements rather than
// relying on inherited white-space CSS.
function renderLines(lines, keyPrefix) {
  const nodes = []
  lines.forEach((line, i) => {
    if (i > 0) nodes.push(<br key={`${keyPrefix}-br-${i}`} />)
    nodes.push(...renderInline(line, `${keyPrefix}-${i}`))
  })
  return nodes
}

/**
 * Parse markdown into React nodes. Returns an array of keyed block elements;
 * render it directly as a child. Never uses dangerouslySetInnerHTML.
 */
export function renderMarkdown(text) {
  const lines = String(text ?? '').split('\n')
  const blocks = []
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.trim() === '') {
      i += 1
      continue
    }

    // Fenced code block: everything to the closing fence (or end of input —
    // vital mid-typewriter, when the closing fence has not "arrived" yet) is
    // literal text.
    if (FENCE.test(line)) {
      const body = []
      i += 1
      while (i < lines.length && !FENCE.test(lines[i])) {
        body.push(lines[i])
        i += 1
      }
      i += 1 // consume the closing fence if present
      blocks.push(
        <pre key={`b-${key}`} className="md-codeblock">
          <code>{body.join('\n')}</code>
        </pre>,
      )
      key += 1
      continue
    }

    const heading = line.match(HEADING_PATTERN)
    if (heading) {
      const Tag = `h${heading[1].length}`
      blocks.push(
        <Tag key={`b-${key}`}>{renderInline(heading[2], `b-${key}`)}</Tag>,
      )
      key += 1
      i += 1
      continue
    }

    if (UNORDERED_ITEM.test(line)) {
      const items = []
      while (i < lines.length && UNORDERED_ITEM.test(lines[i])) {
        items.push(lines[i].match(UNORDERED_ITEM)[1])
        i += 1
      }
      blocks.push(
        <ul key={`b-${key}`}>
          {items.map((item, n) => (
            <li key={n}>{renderInline(item, `b-${key}-${n}`)}</li>
          ))}
        </ul>,
      )
      key += 1
      continue
    }

    if (ORDERED_ITEM.test(line)) {
      const items = []
      while (i < lines.length && ORDERED_ITEM.test(lines[i])) {
        items.push(lines[i].match(ORDERED_ITEM)[1])
        i += 1
      }
      blocks.push(
        <ol key={`b-${key}`}>
          {items.map((item, n) => (
            <li key={n}>{renderInline(item, `b-${key}-${n}`)}</li>
          ))}
        </ol>,
      )
      key += 1
      continue
    }

    // Paragraph: consecutive lines that are none of the above.
    const para = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !FENCE.test(lines[i]) &&
      !HEADING_PATTERN.test(lines[i]) &&
      !UNORDERED_ITEM.test(lines[i]) &&
      !ORDERED_ITEM.test(lines[i])
    ) {
      para.push(lines[i])
      i += 1
    }
    blocks.push(<p key={`b-${key}`}>{renderLines(para, `b-${key}`)}</p>)
    key += 1
  }

  return blocks
}
