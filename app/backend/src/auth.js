// The /api/graphql authentication gate and the default firebase-admin verifier.
//
// Design (docs/architecture.md, Authentication): the verifier is INJECTED through
// createApp({ verifyToken }); this module only supplies the default. The middleware
// never reaches for a module global, so a test substitutes the verifier without
// monkey-patching firebase-admin. That seam is why the existing supertest suite can
// keep running in-process with no emulator and no network.
import { getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'

// The project ID is a public, stable constant already hardcoded across the repo
// (firebase.json, CLAUDE.md, the image path) — NOT a new env var. Verifying an ID
// token needs only this, to check the token's aud/iss; no service-account key and
// no secret. On Cloud Run firebase-admin picks up ADC from the runtime SA, and the
// signing keys come from an unauthenticated Google endpoint.
const PROJECT_ID = 'project-d60a83c1-2c60-4d51-ad0'

// The default verifier. firebase-admin is initialized LAZILY — on the first
// verification, never at import or process start. This is load-bearing: the server
// must still boot and /health must still return 200 with no .env, no ADC, and no
// network (DAN-17's no-.env path, DAN-5's listen-before-connect). An eager
// initializeApp() at import would reach for credentials on a cold container and
// break that path with no test catching it.
export async function firebaseVerifyToken(idToken) {
  if (getApps().length === 0) {
    initializeApp({ projectId: PROJECT_ID })
  }
  return getAuth().verifyIdToken(idToken)
}

// The gate. Mounts on /api/graphql, after /health, before the GraphQL handler.
//
//  - A missing or non-Bearer Authorization header short-circuits to 401 WITHOUT
//    calling the verifier or the data layer.
//  - Otherwise it awaits verifyToken(token). On success it continues to the handler.
//    On ANY rejection it fails the request as 401.
//
// Errors are never formatted inline (CLAUDE.md forbids res.status(...) in handlers):
// the middleware calls next(err) with an error carrying status 401, and the single
// existing error middleware maps it to the { error: { message } } shape. Converting
// EVERY verification rejection into a 401 is exactly what makes a malformed token
// return 401 rather than falling through to the generic 500 branch.
export function authGate(verifyToken) {
  return async function authenticate(req, res, next) {
    const header = req.get('authorization') ?? ''
    const match = /^Bearer (.+)$/.exec(header)
    if (!match) {
      next(unauthorized('Missing or malformed Authorization header'))
      return
    }

    try {
      const decoded = await verifyToken(match[1])
      // DAN-48: thread the caller's identity to the GraphQL layer. The verified
      // token's uid rides on the request so createHandler's context fn (index.js)
      // can expose it to resolvers (myAiUsage, gateway attribution). Minimal
      // seam, added here because origin/main discarded the decoded claims;
      // DAN-47 threads the same thing and the merge reconciles.
      req.uid = decoded?.uid
      next()
    } catch {
      next(unauthorized('Invalid or expired token'))
    }
  }
}

function unauthorized(message) {
  const err = new Error(message)
  err.status = 401
  return err
}
