// The Linear client: the ONE module through which every Linear GraphQL call
// flows (DAN-51). Approving a feature-request plan files a Linear project and
// its tickets; this module owns transport, authentication, and the minimal
// mutation surface that approval needs — nothing else in the backend ever
// talks to Linear.
//
// Seam pattern (docs/architecture.md, Authentication — same shape as
// verifyToken and aiGateway): createApp({ linearClient }) injects an instance
// built here; the approve resolver reaches it through the GraphQL context and
// never constructs its own client. Tests inject a fake that records every call
// and returns fixture ids/urls, so no test reaches real Linear.
//
// Env contract (DAN-51 criterion 1): LINEAR_API_KEY, LINEAR_TEAM_ID, and
// LINEAR_STATE_READY_FOR_DEV are read LAZILY, at call time, never at import or
// factory time — the server must boot and /health must return 200 with none of
// them set, exactly like the no-.env path. Missing config at call time throws
// a LinearError, which the GraphQL error mapper deliberately has no branch
// for: it falls through to INTERNAL, logged server-side, nothing leaked.

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql'
const REQUEST_TIMEOUT_MS = 30_000

// Any Linear failure: missing configuration, network error, non-2xx response,
// or a GraphQL-level error in the response body. Falls through to the
// INTERNAL branch of the one error mapper — the real message is for the
// server-side log only.
export class LinearError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LinearError'
  }
}

// Factory. `fetch` is the injectable transport, so the default client's
// request shape (URL, headers, timeout) is unit-testable without the network.
export function createLinearClient({ fetch: fetchImpl = globalThis.fetch } = {}) {
  // The non-secret configuration the approve flow needs, read lazily from the
  // environment (see CLAUDE.md, Environment, for the DAN team's values).
  // Env-driven with no fallback: missing values throw here, at call time.
  function config() {
    const teamId = process.env.LINEAR_TEAM_ID
    const readyForDevStateId = process.env.LINEAR_STATE_READY_FOR_DEV
    if (!teamId || !readyForDevStateId) {
      throw new LinearError(
        'Linear is not configured: LINEAR_TEAM_ID and LINEAR_STATE_READY_FOR_DEV must be set',
      )
    }
    return { teamId, readyForDevStateId }
  }

  // One GraphQL request against Linear. Linear personal API keys authenticate
  // as a bare `Authorization: <key>` header — NO `Bearer ` prefix (that form
  // is for OAuth tokens, and a prefixed personal key is rejected).
  async function gql(query, variables) {
    const key = process.env.LINEAR_API_KEY
    if (!key) {
      throw new LinearError('Linear is not configured: LINEAR_API_KEY must be set')
    }

    let res
    try {
      res = await fetchImpl(LINEAR_GRAPHQL_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: key,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      throw new LinearError(`Linear request failed: ${err.message}`)
    }

    if (!res.ok) {
      throw new LinearError(`Linear responded ${res.status}`)
    }

    const body = await res.json()
    if (body.errors?.length) {
      throw new LinearError(`Linear returned errors: ${body.errors[0].message}`)
    }
    return body.data
  }

  // Create the project the approved plan's tickets are filed under.
  // Returns { id, url }.
  async function createProject({ name, teamId, description }) {
    const data = await gql(
      `mutation ($input: ProjectCreateInput!) {
        projectCreate(input: $input) { project { id url } }
      }`,
      { input: { name, teamIds: [teamId], description } },
    )
    return data.projectCreate.project
  }

  // Create one issue. `stateId` is optional: passing the Ready for Dev state
  // files the issue directly in that state; omitting it leaves the issue in
  // the team's default state (Backlog). Returns { id, identifier, url }.
  async function createIssue({ teamId, projectId, title, description, labelIds, stateId }) {
    const input = { teamId, projectId, title, description, labelIds }
    if (stateId !== undefined) input.stateId = stateId
    const data = await gql(
      `mutation ($input: IssueCreateInput!) {
        issueCreate(input: $input) { issue { id identifier url } }
      }`,
      { input },
    )
    return data.issueCreate.issue
  }

  // Create one issue relation. With type "blocks", `issueId` blocks
  // `relatedIssueId` — Linear renders the inverse "blocked by" on the related
  // issue automatically. Returns { id }.
  async function createRelation({ issueId, relatedIssueId, type }) {
    const data = await gql(
      `mutation ($input: IssueRelationCreateInput!) {
        issueRelationCreate(input: $input) { issueRelation { id } }
      }`,
      { input: { issueId, relatedIssueId, type } },
    )
    return data.issueRelationCreate.issueRelation
  }

  // Resolve label names to ids, creating any that don't exist yet in the
  // configured team. Returns { [name]: id } for exactly the requested names.
  async function findOrCreateLabels(names) {
    const { teamId } = config()
    const data = await gql(
      `query ($teamId: ID!, $names: [String!]!) {
        issueLabels(filter: { team: { id: { eq: $teamId } }, name: { in: $names } }) {
          nodes { id name }
        }
      }`,
      { teamId, names },
    )

    const idsByName = {}
    for (const node of data.issueLabels.nodes) {
      idsByName[node.name] = node.id
    }
    for (const name of names) {
      if (idsByName[name]) continue
      const created = await gql(
        `mutation ($input: IssueLabelCreateInput!) {
          issueLabelCreate(input: $input) { issueLabel { id name } }
        }`,
        { input: { teamId, name } },
      )
      idsByName[name] = created.issueLabelCreate.issueLabel.id
    }
    return idsByName
  }

  // Read live build progress for a set of issues in ONE GraphQL query
  // (DAN-52): the watch-it-build view polls this per session, so one round
  // trip per poll, never one per issue. Returns Linear's raw per-issue nodes —
  //   { id, identifier, title, url, state { name, type },
  //     attachments { nodes { url, sourceType } },
  //     inverseRelations { nodes { type, issue { id } } } }
  // — and the mapping to the DAN-52 wire shape (state names, PR detection,
  // blockedBy) lives in the data layer (featureRequests.js), not here: this
  // module owns transport, not presentation.
  //
  // `inverseRelations` are the relations where this issue is the TARGET
  // (relatedIssue): for a "blocks" relation, `issue` is the blocker — which is
  // exactly what "blocked by" needs.
  async function issuesProgress(issueIds) {
    const data = await gql(
      `query ($ids: [ID!]!) {
        issues(filter: { id: { in: $ids } }) {
          nodes {
            id
            identifier
            title
            url
            state { name type }
            attachments { nodes { url sourceType } }
            inverseRelations { nodes { type issue { id } } }
          }
        }
      }`,
      { ids: issueIds },
    )
    return data.issues.nodes
  }

  return {
    config,
    createProject,
    createIssue,
    createRelation,
    findOrCreateLabels,
    issuesProgress,
  }
}
