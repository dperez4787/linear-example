// DAN-86: unit tests for the gateway attribution header builder.
// Run: node --test '.github/scripts/*.test.mjs'

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAttributionHeaders,
  extractPromptId,
  __mainForTests as main,
  __parseArgsForTests as parseArgs,
} from "./gateway-attribution.mjs";

const lines = (block) => block.split("\n");
const headerMap = (block) =>
  Object.fromEntries(
    lines(block).map((line) => {
      const idx = line.indexOf(": ");
      return [line.slice(0, idx), line.slice(idx + 2)];
    }),
  );

// ---- extractPromptId ----------------------------------------------------

test("extractPromptId returns the suffix of a prompt:* label", () => {
  assert.equal(extractPromptId(["prompt:i18n", "agent-tested"]), "i18n");
});

test("extractPromptId returns '' when no prompt label is present", () => {
  assert.equal(extractPromptId(["agent-tested", "bug"]), "");
  assert.equal(extractPromptId([]), "");
});

test("extractPromptId tolerates non-array and non-string input", () => {
  // Linear label payloads have been null before; a crash here would fail the
  // build leg over metadata, which is exactly backwards.
  assert.equal(extractPromptId(undefined), "");
  assert.equal(extractPromptId(null), "");
  assert.equal(extractPromptId("prompt:x"), "");
  assert.equal(extractPromptId([null, 42, "prompt:ok"]), "ok");
});

test("extractPromptId ignores a bare 'prompt:' label with no suffix", () => {
  assert.equal(extractPromptId(["prompt:"]), "");
  assert.equal(extractPromptId(["prompt:   "]), "");
  // ...but still finds a real one later in the list.
  assert.equal(extractPromptId(["prompt:", "prompt:real"]), "real");
});

test("extractPromptId does not match labels that merely contain 'prompt:'", () => {
  assert.equal(extractPromptId(["not-a-prompt:x"]), "");
});

test("extractPromptId takes the FIRST prompt label when several exist", () => {
  assert.equal(extractPromptId(["prompt:a", "prompt:b"]), "a");
});

// ---- buildAttributionHeaders -------------------------------------------

test("prompt-labeled ticket carries both promptId and ticket", () => {
  const block = buildAttributionHeaders({
    ticket: "DAN-86",
    role: "developer",
    labels: ["prompt:i18n"],
  });
  assert.deepEqual(headerMap(block), {
    "x-gateway-feature": "ci-build",
    "x-gateway-role": "developer",
    "x-gateway-ticket": "DAN-86",
    "x-gateway-prompt-id": "i18n",
  });
});

test("unlabeled ticket OMITS the prompt-id header rather than sending it empty", () => {
  // An empty value would write promptId="" to the ledger, which matches "has a
  // promptId" in the obvious query while meaning the opposite.
  const block = buildAttributionHeaders({
    ticket: "DAN-42",
    role: "tester",
    labels: ["agent-tested"],
  });
  assert.ok(!block.includes("x-gateway-prompt-id"), block);
  assert.deepEqual(headerMap(block), {
    "x-gateway-feature": "ci-build",
    "x-gateway-role": "tester",
    "x-gateway-ticket": "DAN-42",
  });
});

test("unlabeled tickets are still attributed to feature and ticket", () => {
  const block = buildAttributionHeaders({ ticket: "DAN-42", role: "developer" });
  const map = headerMap(block);
  assert.equal(map["x-gateway-feature"], "ci-build");
  assert.equal(map["x-gateway-ticket"], "DAN-42");
});

test("both legs are distinguishable by role", () => {
  const dev = headerMap(buildAttributionHeaders({ ticket: "DAN-1", role: "developer" }));
  const test_ = headerMap(buildAttributionHeaders({ ticket: "DAN-1", role: "tester" }));
  assert.equal(dev["x-gateway-role"], "developer");
  assert.equal(test_["x-gateway-role"], "tester");
});

test("an unknown role is rejected, not silently passed through", () => {
  // A typo'd role would open a third ledger bucket no report looks at.
  assert.throws(() => buildAttributionHeaders({ ticket: "DAN-1", role: "dev" }), /role must be one of/);
  assert.throws(() => buildAttributionHeaders({ ticket: "DAN-1", role: "" }), /role must be one of/);
  assert.throws(() => buildAttributionHeaders({ ticket: "DAN-1" }), /role must be one of/);
  assert.throws(() => buildAttributionHeaders({ ticket: "DAN-1", role: "Developer" }), /role must be one of/);
});

test("a missing or blank ticket is rejected", () => {
  assert.throws(() => buildAttributionHeaders({ role: "developer" }), /ticket is required/);
  assert.throws(() => buildAttributionHeaders({ ticket: "   ", role: "developer" }), /ticket is required/);
  assert.throws(() => buildAttributionHeaders(), /ticket is required/);
});

test("ticket and feature are trimmed", () => {
  const map = headerMap(
    buildAttributionHeaders({ ticket: " DAN-86 ", role: "developer", feature: " ci-build " }),
  );
  assert.equal(map["x-gateway-ticket"], "DAN-86");
  assert.equal(map["x-gateway-feature"], "ci-build");
});

test("a newline in ticket or prompt label cannot forge extra headers", () => {
  // The block is newline-delimited; an embedded newline would inject headers.
  assert.throws(
    () => buildAttributionHeaders({ ticket: "DAN-1\nx-gateway-role: admin", role: "developer" }),
    /may not contain a newline/,
  );
  assert.throws(
    () =>
      buildAttributionHeaders({
        ticket: "DAN-1",
        role: "developer",
        labels: ["prompt:a\r\nx-gateway-feature: app"],
      }),
    /may not contain a newline/,
  );
});

test("the block never contains key material", () => {
  const block = buildAttributionHeaders({
    ticket: "DAN-86",
    role: "developer",
    labels: ["prompt:i18n"],
  });
  // The virtual key is concatenated by the workflow from the secret directly,
  // so GitHub's masking covers it; this script's output is log-safe.
  assert.ok(!/x-gateway-key/i.test(block), block);
  assert.ok(!/authorization/i.test(block), block);
});

test("the block is exactly the headers, with no trailing newline", () => {
  const block = buildAttributionHeaders({ ticket: "DAN-86", role: "developer" });
  assert.equal(lines(block).length, 3);
  assert.ok(!block.endsWith("\n"));
  for (const line of lines(block)) assert.match(line, /^x-gateway-[a-z-]+: \S.*$/);
});

// ---- CLI ----------------------------------------------------------------

test("parseArgs reads flags and the --github-env boolean", () => {
  const args = parseArgs(["--ticket", "DAN-86", "--role", "tester", "--github-env"]);
  assert.equal(args.ticket, "DAN-86");
  assert.equal(args.role, "tester");
  assert.equal(args.githubEnv, true);
});

test("CLI prints the header block", () => {
  const out = main(["--ticket", "DAN-86", "--role", "developer", "--labels", '["prompt:i18n"]']);
  assert.equal(headerMap(out)["x-gateway-prompt-id"], "i18n");
});

test("CLI --github-env emits a heredoc that brackets the block", () => {
  const out = main(["--ticket", "DAN-86", "--role", "developer", "--github-env"]);
  const outLines = out.split("\n");
  const opener = outLines[0];
  assert.match(opener, /^ANTHROPIC_CUSTOM_HEADERS<<GWATTR_[A-Z0-9]+$/);
  const delimiter = opener.slice("ANTHROPIC_CUSTOM_HEADERS<<".length);
  assert.equal(outLines.at(-1), delimiter);
  // The bracketed body is exactly the header block.
  assert.equal(
    outLines.slice(1, -1).join("\n"),
    buildAttributionHeaders({ ticket: "DAN-86", role: "developer" }),
  );
});

test("CLI rejects malformed --labels instead of dropping attribution", () => {
  assert.throws(
    () => main(["--ticket", "DAN-86", "--role", "developer", "--labels", "not-json"]),
    /--labels must be a JSON array/,
  );
});

test("CLI surfaces a bad role as an error", () => {
  assert.throws(() => main(["--ticket", "DAN-86", "--role", "nope"]), /role must be one of/);
});
