// Role system prompts for the feature-request conversation (DAN-49). The
// prompts are CHECKED-IN files under app/backend/roles/ — not literals in code —
// so the product owner and architect voices can be tuned by editing markdown,
// reviewed in a diff, and asserted byte-for-byte by tests (the captured gateway
// request must carry exactly the file's content as its system message).
//
// The files are read lazily on first use and cached for the process lifetime:
// boot and /health stay filesystem-quiet, and a running server never re-reads
// per request. The Dockerfile copies roles/ alongside src/ so the prompts exist
// in the container image.
import { readFile } from 'node:fs/promises'

// The conversational roles that take a turn in the transcript. The planner
// (see featureRequests.js) is internal and has no checked-in file — its prompt
// demands machine-readable JSON, which is code contract, not tunable voice.
export const CONVERSATION_ROLES = ['product-owner', 'architect']

const cache = new Map()

// Load a role's system prompt from roles/<name>.md. Only the known role names
// are loadable — the name is interpolated into a path, so this guard is a
// boundary, not a nicety.
export async function loadRolePrompt(name) {
  if (!CONVERSATION_ROLES.includes(name)) {
    throw new Error(`unknown role: ${name}`)
  }
  if (!cache.has(name)) {
    cache.set(
      name,
      await readFile(new URL(`../roles/${name}.md`, import.meta.url), 'utf8'),
    )
  }
  return cache.get(name)
}
