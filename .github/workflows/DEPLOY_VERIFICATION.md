# DAN-13 tester verification — `deploy.yml`

There is no workflow test framework in this repo; `actionlint` plus static inspection
**are** the test for `.github/workflows/deploy.yml`. This note records what was run and
observed. No deploy was executed: no workflow run, no `gcloud run deploy`, no
`terraform apply`, no push to `main` (a push to `main` is itself this workflow's trigger).

## Commands and real output

```
$ actionlint .github/workflows/deploy.yml
(no output)
ACTIONLINT_EXIT=0
```

`actionlint` prints nothing on success; exit code `0` with zero findings.

```
$ ruby -ryaml -e "d=YAML.load_file('.github/workflows/deploy.yml'); ..."
YAML_VALID: parsed OK
permissions: {"contents"=>"read", "id-token"=>"write"}
```

(The `on:` key parses as boolean `true` under Ruby's YAML 1.1 `on`→true rule; harmless —
actionlint recognized the `push` trigger and exited 0.)

## Agent-checkable criteria: all PASS

1. `deploy.yml` exists, valid YAML, `actionlint` exit 0, no findings.
2. `push` → `main`; `google-github-actions/auth@v2` wired from `${{ secrets.WIF_PROVIDER }}`
   / `${{ secrets.DEPLOY_SA }}`; no key file, no `credentials_json`, no `FIREBASE_TOKEN`.
3. `permissions:` = `contents: read` + `id-token: write` (confirmed by parse).
4. Image tag `…/linear-example/backend:${{ github.sha }}` — SHA, never `latest`
   (`ubuntu-latest` and `MONGODB_URI:latest` are unrelated and legitimate).
5. `docker build -f app/backend/Dockerfile`; no `--source`/Cloud Build;
   `gcloud auth configure-docker us-central1-docker.pkg.dev` runs before `docker push`.
6. `gcloud run deploy linear-example-backend`, `--region us-central1`,
   `--min-instances=1`, `--cpu-boost`,
   `--service-account=linear-example-run@…`, `--set-secrets=MONGODB_URI=MONGODB_URI:latest`.
7. `--allow-unauthenticated` present on the deploy command (not a comment);
   `--no-allow-unauthenticated` absent.
8. Only `.github/workflows/deploy.yml` and `docs/architecture.md` changed vs `main`;
   architecture.md states the invoker policy.

## User-attested criteria: pending user attestation (no agent can verify)

Revision deploying and serving; container reading `MONGODB_URI` from Secret Manager at
startup; `/healthz` answering at the Cloud Run URL. Observable only after the user merges.

**Merging PR #15 triggers the first real deploy and the first-ever OIDC-token exchange for
the deploy SA.** Every trust-path component is verified to exist, but a first exchange has
never happened; a subtly wrong attribute condition or principalSet fails inside
`google-github-actions/auth`, before anything builds.
