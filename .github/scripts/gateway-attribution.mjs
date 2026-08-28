#!/usr/bin/env node
// DAN-86: builds the per-run attribution header block that CI agent traffic
// carries to the ai-gateway ledger (DAN-85 passthrough).
//
// ============================ NOT WIRED UP YET ============================
// Nothing in .github/workflows/linear-agents.yml calls this script. Routing
// claude-code-action through the gateway is BLOCKED on the passthrough gaining
// streaming support — see the DAN-86 block in the workflow header for the
// measurements. This module is the non-streaming half of DAN-86, landed tested
// and ready so the follow-up is a wiring change and not a design change.
// =========================================================================
//
// The gateway reads attribution from optional request headers and copies them
// into the ledger row's metadata. Claude Code forwards ANTHROPIC_CUSTOM_HEADERS
// verbatim on every upstream request (measured, see the workflow header), so the
// header block below is the transport once the streaming blocker clears.
//
// What this module emits, per the DAN-85 contract:
//
//   x-gateway-feature    always "ci-build" — every token spent by the remote
//                        developer/tester legs belongs to the CI build line,
//                        which is what makes build cost separable from app cost.
//   x-gateway-role       "developer" or "tester" — which leg spent it. Rejecting
//                        every other value is deliberate: a typo'd role would
//                        silently split the ledger into a third bucket that no
//                        report knows to look at.
//   x-gateway-ticket     the Linear identifier (e.g. "DAN-86"), so a ticket's
//                        build cost is answerable without a join through Linear.
//   x-gateway-prompt-id  the suffix of the ticket's `prompt:*` label, which ties
//                        CI spend to the prompt-a-feature run that caused it.
//
// SECRETS ARE NOT THIS MODULE'S JOB. The virtual key (x-gateway-key) is NEVER
// built here and never passes through this script's stdout. The workflow
// concatenates that line straight from ${{ secrets.AI_GATEWAY_CI_KEY }} so
// GitHub's masking covers it end to end; anything this script prints is safe to
// echo in a public build log, and it must stay that way.
//
// Absent prompt label → the header is OMITTED, not emitted empty. An empty
// `x-gateway-prompt-id: ` would write promptId="" into the ledger, and ""
// matches "has a promptId" in the obvious query while meaning the opposite. An
// absent header leaves the field null, which reports the truth: this build
// belonged to no prompt run. (Unlabeled tickets still bill to feature=ci-build
// with their ticket — they are attributed, just not to a prompt.)
//
// Unit tests: node --test '.github/scripts/*.test.mjs'

/** Header values may not contain CR/LF: the block is newline-delimited, so an
 * embedded newline in a ticket id or label would forge additional headers. */
const FORBIDDEN = /[\r\n]/;

const VALID_ROLES = new Set(["developer", "tester"]);

/**
 * The prompt run a ticket belongs to, from its Linear labels.
 * @param {string[]} labels label names as Linear returns them
 * @returns {string} the first `prompt:*` label's suffix, or "" when unlabeled
 */
export function extractPromptId(labels) {
  if (!Array.isArray(labels)) return "";
  for (const label of labels) {
    if (typeof label !== "string") continue;
    if (!label.startsWith("prompt:")) continue;
    const id = label.slice("prompt:".length).trim();
    if (id) return id;
  }
  return "";
}

/**
 * The ANTHROPIC_CUSTOM_HEADERS block for one agent leg.
 * @param {{ticket: string, role: string, labels?: string[], feature?: string}} opts
 * @returns {string} newline-separated `Name: value` lines (no trailing newline)
 */
export function buildAttributionHeaders({
  ticket,
  role,
  labels = [],
  feature = "ci-build",
} = {}) {
  if (typeof ticket !== "string" || !ticket.trim()) {
    throw new Error("ticket is required (the Linear identifier, e.g. DAN-86)");
  }
  if (!VALID_ROLES.has(role)) {
    throw new Error(
      `role must be one of ${[...VALID_ROLES].join(", ")}; got ${JSON.stringify(role)}`,
    );
  }
  if (typeof feature !== "string" || !feature.trim()) {
    throw new Error("feature must be a non-empty string");
  }

  const promptId = extractPromptId(labels);
  const headers = [
    ["x-gateway-feature", feature.trim()],
    ["x-gateway-role", role],
    ["x-gateway-ticket", ticket.trim()],
  ];
  if (promptId) headers.push(["x-gateway-prompt-id", promptId]);

  for (const [name, value] of headers) {
    if (FORBIDDEN.test(value)) {
      throw new Error(`header ${name} may not contain a newline: ${JSON.stringify(value)}`);
    }
  }
  return headers.map(([name, value]) => `${name}: ${value}`).join("\n");
}

// ---- CLI ----------------------------------------------------------------
// node .github/scripts/gateway-attribution.mjs \
//   --ticket DAN-86 --role developer --labels '["prompt:i18n"]' [--github-env]
//
// Default output is the raw header block on stdout. --github-env wraps it in
// the heredoc form $GITHUB_ENV requires for a multi-line value, so a future
// workflow step can append it directly. The random delimiter is not decoration:
// a value containing the delimiter would end the block early, and this value is
// partly ticket-derived.

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key === "github-env") {
      args.githubEnv = true;
      continue;
    }
    args[key] = argv[++i];
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  let labels = [];
  if (args.labels) {
    try {
      labels = JSON.parse(args.labels);
    } catch {
      throw new Error("--labels must be a JSON array of label names");
    }
  }
  const block = buildAttributionHeaders({
    ticket: args.ticket,
    role: args.role,
    labels,
    ...(args.feature ? { feature: args.feature } : {}),
  });
  if (args.githubEnv) {
    const delimiter = `GWATTR_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    if (block.includes(delimiter)) throw new Error("delimiter collision; re-run");
    return `ANTHROPIC_CUSTOM_HEADERS<<${delimiter}\n${block}\n${delimiter}`;
  }
  return block;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`::error::${err.message}`);
    process.exit(1);
  }
}

export { main as __mainForTests, parseArgs as __parseArgsForTests };
