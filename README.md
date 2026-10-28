# Postman → Playwright API Automation

Turn an exported **Postman collection** into **executable Playwright API tests**, run them with Playwright Test's `APIRequestContext`, and get a **professional HTML report** — from a web dashboard or the command line.

Nothing in the tool is specific to one API: endpoints, folders, variables, auth and checks all come from the collection you upload.

---

## 1. What it does

| Stage | What happens |
|---|---|
| **Parse** | Reads Postman Collection v2.0 / v2.1, walks nested folders, extracts method, URL, query, headers, body (raw/JSON, urlencoded, form-data, GraphQL), auth, variables, saved example responses and pre-request/test scripts. Disabled headers/params are dropped; unsupported features are reported. |
| **Generate** | Writes one readable `.spec.js` per top-level folder into `generated-tests/`, tests in collection order. Postman `pm.*` assertions are converted into Playwright `expect` calls; literal secrets are moved out of the code. |
| **Run** | Executes the suite with `@playwright/test` (`APIRequestContext`, no browser). Safe defaults: 1 worker, no retries, mutating requests blocked unless allowed. |
| **Report** | `reports/api-report.html` (human-friendly), `reports/summary.json` (machine-readable) and Playwright's own report in `reports/playwright-report/`. Secrets are redacted everywhere. |

---

## 2. Setup on Windows (PowerShell)

Requirements: **Node.js 20.12 or newer** (tested with Node 24.21 and Playwright 1.56.1). No browser download is needed because the tests only make HTTP calls.

```powershell
cd "C:\Users\Junaid\Desktop\Automation Code\playwright-api-automation-testing"
npm install
Copy-Item .env.example .env   # only if .env does not exist yet; then edit it
```

## 3. Start the dashboard

```powershell
npm start
```

Open **http://127.0.0.1:3000**. The server only listens on localhost by default.

1. **Upload**: drop the collection `.json` file (and optionally a Postman environment file). It is validated immediately, and you see the request count, folders and any warnings.
2. **Generate tests**: inspect the generated Playwright code per file in the code viewer.
3. **Run tests**: optionally set a *target base URL override*, timeout, workers and baseline rule. Tick **Allow POST/PUT/PATCH/DELETE** only for non-production targets.
4. **Results**: PASS/FAIL/SKIP summary and failed-request details, with buttons to **Open HTML report**, open the **Playwright report**, or **Download summary.json**.

## 4. Command line (CI friendly)

```powershell
# generate only
npm run generate -- --collection .\collections\JSONPlaceholder_CRUD_API_Collection.json

# run the generated suite (exit code 1 if any test fails)
npm run run-tests

# both, with overrides
node src/cli.js all --collection .\collections\my.json --environment .\collections\qa.postman_environment.json --target https://qa.example.com --allow-mutating

# plain Playwright also works (uses playwright.config.js + .env)
npx playwright test

# what the GitHub workflow runs: every collection in collections\ (or COLLECTION=<file name>)
npm run ci
```

### 4.1 Run on GitHub (manual only)

The workflow `.github/workflows/api-tests.yml` runs **only when started by hand**. It never runs on push, pull request or a schedule.

**1. Put the collection in the repository.** GitHub can only read files that are in the repo:

```
collections/
  JSONPlaceholder_CRUD_API_Collection.json
  your-new-collection.json        ← GitHub: open collections/ → Add file → Upload files → Commit
```

Collections in the repo are visible to everyone with access to it. They must contain **no real passwords, tokens or customer data**, only `{{variables}}`.

**2. Add credentials as secrets (only if the API needs them).** Go to *Settings → Secrets and variables → Actions → New repository secret*, for example `PM_VAR_username`, `PM_VAR_password`, `PM_VAR_accessToken`. Each secret named `PM_VAR_<name>` becomes the Postman variable `{{name}}`. Other secrets are ignored. Values are masked in logs and reports.

**3. Start it.** Go to *Actions → API Tests → Run workflow* and fill in:

| Field | Meaning |
|---|---|
| Collection | **Leave empty to run every collection** in `collections/`, or type one file name, e.g. `JSONPlaceholder_CRUD_API_Collection.json` (the `.json` is optional). An unknown name stops the run and lists the available files. |
| Target URL | Optional base URL override, e.g. `https://jsonplaceholder.typicode.com` or your QA server. Empty means the URLs inside the collection. |
| Allow POST/PUT/PATCH/DELETE | Off by default (writes are skipped). Tick it only for non-production targets. |
| Request timeout | Milliseconds, default 15000. |
| Run self-tests | Also run the tool's own 77 tests first. |

**4. Read the result.** The run turns green when everything passes and red when any test fails. The run page shows a summary table per collection, including the failed requests. Download the **api-test-reports** artifact (kept for 14 days), unzip it, and open `reports/<collection-name>/api-report.html`.

For the sample collection, use target `https://jsonplaceholder.typicode.com` and tick *Allow POST/PUT/PATCH/DELETE*. Without them, the original host may be unreachable and the 24 write requests are skipped.

`auth.config.json` (automatic login) is used in CI too when it is committed. It contains no secrets by design.

## 5. Reports

| File | Purpose |
|---|---|
| `reports\api-report.html` | Main report. It shows a verdict and KPI cards (total, passed, failed, skipped, pass rate, checks, avg/p95 response time, duration), a plain-language summary, HTTP status distribution, slowest requests, and a **Failures** section with the failure type, the failed checks with expected vs actual values and a *What to check* hint. It also has a filterable table of all requests: click a row to see the sanitized request and response (headers and body), each check and its origin, and saved variables. A per-folder breakdown, collection conversion notes and a *How to read this report* glossary are included. Works offline. |
| `reports\summary.json` | The same data without headers or bodies, for CI dashboards. |
| `reports\playwright-report\index.html` | Playwright's built-in technical report (steps per check). Open it with `npx playwright show-report reports\playwright-report`. |

**Check origins** shown in reports:
- `[collection]`: converted from the collection's own Postman test scripts (real expectations).
- `[example]`: expected status taken from a saved example response.
- `[baseline]`: a generic default added when the collection defines nothing. It checks that the status is 2xx (configurable) and that a body declared as JSON parses. **A baseline check is not a business requirement.**

**Failure types**: assertion failure · HTTP error (4xx/5xx and failed checks) · network error · timeout · configuration problem (e.g. an unresolved `{{variable}}`). A 4xx can still **pass** when the collection expects it (negative tests).

## 6. Configuration (`.env`)

All settings are environment variables. See `.env.example` for the full list.

| Variable | Default | Meaning |
|---|---|---|
| `TARGET_BASE_URL` | *(empty)* | Replaces scheme, host and port of every request URL (keeps path and query). Empty means the URLs in the collection are used. |
| `PM_VAR_<name>` | — | Overrides any Postman variable, e.g. `PM_VAR_baseUrl`, `PM_VAR_token`. |
| `ALLOW_MUTATING_REQUESTS` | `false` | POST/PUT/PATCH/DELETE are **skipped** unless `true`. |
| `RETRY_MUTATING_REQUESTS` | `false` | Retries never re-send mutating requests unless `true`. |
| `WORKERS` | `1` | Parallel workers. Forced to 1 when requests depend on each other. |
| `RETRIES` | `0` | Playwright retries. |
| `REQUEST_TIMEOUT_MS` / `TEST_TIMEOUT_MS` | `15000` / `30000` | Per-request and per-test time limits. |
| `BASELINE_STATUS` | `2xx` | `2xx`, `non-5xx` or `none`. Used only when the collection defines no expected status. |
| `MAX_RESPONSE_TIME_MS` | `0` | When greater than 0, slower responses fail a baseline check. |
| `REPORT_INCLUDE_BODIES` / `REPORT_BODY_LIMIT` | `true` / `4000` | Include redacted, truncated bodies in the report. |
| `PLAYWRIGHT_HTML_REPORT` | `true` | Also write Playwright's built-in report. |
| `HOST` / `PORT` / `MAX_UPLOAD_MB` | `127.0.0.1` / `3000` / `5` | Dashboard server settings. |

The current local `.env` sets `TARGET_BASE_URL=https://jsonplaceholder.typicode.com` and `ALLOW_MUTATING_REQUESTS=true`. The reason is in *Verification* below.

## 7. Variables and authentication

**Variable precedence** (highest first):
1. runtime values set during the run (`pm.environment.set(...)` extractions, such as a login token)
2. `PM_VAR_<name>` overrides
3. the uploaded Postman environment
4. folder variables (nearest folder first)
5. collection variables

Dynamic variables `{{$guid}}`, `{{$randomUUID}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomInt}}`, `{{$randomEmail}}` and a few others are supported.

**Auth**: `bearer`, `basic`, `apikey` (header or query) and `noauth`, with inheritance collection → folder → request. A request-level setting overrides its parent, and `noauth` switches auth off. Other types (OAuth2, AWS SigV4, Digest, NTLM, …) produce a **skipped** test with a clear reason. As a workaround, obtain the token yourself and use bearer auth with `PM_VAR_token`.

**Login / chaining**: if a login request's test script contains `pm.environment.set("token", pm.response.json().token)`, the generated test extracts it, and later requests that use `{{token}}` (for example via collection bearer auth) receive it. The same applies to IDs from create requests. Chained suites always run with 1 worker in collection order.

**Secrets**:
- Literal tokens, passwords and API keys found in auth, sensitive headers, query params or JSON body fields are moved to `generated-tests\.secrets.json` (git-ignored) and referenced as `{{__secret_N}}`.
- Values are registered at runtime and masked as `***REDACTED***` in logs, attachments and all reports.
- Prefer passing real credentials via `PM_VAR_*` environment variables, never by committing them.

### 7.1 Automatic authentication (`auth.config.json`)

Use this when an API needs a login call that returns an access token. It works even when the collection has **no Postman scripts**. Copy `auth.config.example.json` to `auth.config.json`, or point `AUTH_CONFIG=<path>` at another file. If the file does not exist, automatic authentication is off and everything else works as before.

```json
{
  "login": {
    "request": "Auth / Login",
    "tokenPath": "data.accessToken",
    "tokenVariable": "accessToken",
    "refreshTokenPath": "data.refreshToken",
    "refreshTokenVariable": "refreshToken",
    "expiresInPath": "data.expiresIn"
  },
  "refresh": { "enabled": true, "request": "Auth / Refresh Token", "on401": true, "beforeExpirySeconds": 30, "retryMutating": false },
  "defaultAuth": { "type": "bearer", "token": "{{accessToken}}" }
}
```

| Field | Meaning |
|---|---|
| `login.request` | Name of the login request, or `"Folder / Name"` when names repeat. It is matched by **name, never by position or by how many requests the collection has**. |
| `login.tokenPath` | JSON path of the access token in the login response, e.g. `token`, `data.accessToken`, `result.items[0].jwt`. |
| `login.tokenVariable` | Variable that protected requests use, e.g. collection auth `Bearer {{accessToken}}`. |
| `login.refreshTokenPath` / `refreshTokenVariable` | Optional. Where the refresh token is, and the variable the refresh request sends. |
| `login.expiresInPath` | Optional. Expiry in seconds, used for proactive refresh. |
| `refresh.enabled` | Token refresh happens **only** when this is `true`. Without `refresh.request`, the login is repeated instead. |
| `refresh.on401` | When a protected request gets 401: refresh the token once and retry that request once. |
| `refresh.retryMutating` | POST/PUT/PATCH/DELETE are not re-sent after a 401 unless this is `true`. |
| `defaultAuth` | Optional auth for requests that have **no auth anywhere** (request, folder or collection). An explicit `noauth` is always respected. |

**How it behaves**:
- **Login on demand**: when the first protected request runs and the token variable is empty, the configured login request is sent automatically. This works even if the login request comes later in the collection.
- **Token reuse**: the token is stored once and reused by every later request. The login is not repeated per request.
- **Overrides are preserved**: auth is inherited request → folder → collection. A request with explicit `noauth`, its own Basic/API key auth, or a different bearer token keeps it.
- **Writes still blocked**: the configured login and refresh requests may run even when `ALLOW_MUTATING_REQUESTS=false`. All other writes stay blocked.
- **Ordered execution**: with automatic login, the suite always runs with 1 worker.
- **Report**: the login and refresh requests get an `[auth]` check ("access token extracted from …"). The report shows an *Automatic authentication* card (config, token path, number of logins and refreshes) and a per-request *Authentication* panel (auth type, where it was defined, login/refresh events).

**Credentials are never stored in the config.** A literal password, token or key in `auth.config.json` is rejected with an error that names the field but not the value. Credentials come from variables (`{{username}}`, `{{password}}`) supplied via `PM_VAR_<name>` or a Postman environment file.

**Clear errors instead of business failures**:

| Situation | Category in the report | Request sent? |
|---|---|---|
| Token or credential variable missing or empty, e.g. `Bearer token needs {{accessToken}}, which is not defined (auth defined at collection). Provide it via PM_VAR_accessToken …` | **Authentication setup problem** (`auth-config`) | No |
| `auth.config.json` invalid (bad JSON, missing field, literal credential, login request not found or ambiguous) | `auth-config` | Protected requests: no |
| Login returned 200 but there was no token at `tokenPath` (the message lists the response field names, never the values) | `auth-config` | — |
| Login rejected (401/403): "credentials are invalid … check {{username}}, {{password}}". It is not retried for every request. | **Authentication rejected** (`auth-rejected`) | Protected requests: no |
| A protected request still gets 401/403 (refresh off, or refresh failed) | `auth-rejected` | Yes |
| The collection itself **expects** 401 (negative test, e.g. `pm.response.to.have.status(401)`) | PASS | Yes |

## 8. Postman script conversion

Imported scripts are **never executed**. They are tokenised and pattern-matched, and anything else is listed as unsupported, both in the generated test's annotations and in the report's *Collection conversion notes*.

Supported test-script patterns:

```js
pm.test("name", function () { ... })            // becomes one named check; all checks run (soft), like Postman
pm.response.to.have.status(201)                 // also "Created" status text
pm.response.to.be.ok | success | created | accepted | badRequest | unauthorized | forbidden | notFound
               | rateLimited | clientError | serverError | error | redirection | info   (with .not)
pm.expect(pm.response.code).to.eql(200) / .to.be.oneOf([200, 201])
pm.response.to.have.header("X"[, "value"])
pm.expect(pm.response.headers.get("Content-Type")).to.include("json")
pm.expect(pm.response.responseTime).to.be.below(500)
pm.response.to.be.json  /  pm.response.to.have.jsonBody(["a.b"[, value]])
pm.expect(pm.response.text()).to.include("x")  /  pm.response.to.have.body("x")
var jsonData = pm.response.json();  const id = jsonData.data.id;   // aliases
pm.expect(jsonData.a.b[0]).to.eql | equal | deep.equal | have.property | be.a/an | include | have.lengthOf |
          be.above | below | at.least | at.most | oneOf | match(/re/) | exist | be.true | be.false |
          be.null | be.undefined | be.empty | be.ok        (with .not, and chains such as .to.be.an('array').that.is.not.empty)
pm.environment | collectionVariables | globals | variables .set("name", <json path | header | literal>) / .unset()
tests["name"] = responseCode.code === 200;       // legacy syntax
postman.setEnvironmentVariable("name", jsonData.id)
```

Pre-request scripts: literal assignments only, e.g. `pm.environment.set("lang", "en")` or `pm.variables.set("id", pm.variables.replaceIn("{{$guid}}"))`.

Not converted (reported instead): `if/for/try` logic, `pm.sendRequest`, `setNextRequest`, custom functions and computed values, `require(...)`, crypto/signing, and schema validation (`tv4`, `ajv`).

## 9. Architecture

```
src/
  config.js                      env-driven configuration (.env loader, defaults, limits)
  cli.js                         generate / run / all commands
  server.js                      dashboard backend (node:http, no framework)
  parser/
    collection-parser.js         validation + normalized request model (v2.0/v2.1)
    variable-resolver.js         {{variable}} resolution with scope precedence
  generator/
    assertion-converter.js       Postman script → assertion/extraction model (no eval)
    playwright-generator.js      model → readable .spec.js files, secrets extraction
  runtime/
    api-fixture.js               `api` fixture used by generated tests (send, auth, checks)
    global-setup.js              clears chained variables before each run
  runner/test-runner.js          runs Playwright in a child process (no shell)
  reporter/
    api-reporter.js              custom Playwright reporter → summary.json + HTML
    report-service.js            report data model + self-contained HTML renderer
  utils/redact.js                secret detection and masking
  web/                           dashboard (index.html, app.js, styles.css)
tests/                           the tool's own tests (node:test) + mock API + fixture collection
generated-tests/                 output of the generator (git-ignored)
reports/                         output of runs (git-ignored)
collections/                     input collections
```

**Security model**:
- Uploads are parsed as JSON only, size-limited, and never executed.
- Every generated string goes through `JSON.stringify` and comments are single-line, so collection content cannot inject code. Each generated file is syntax-checked with `vm.Script` (compile only).
- The runner passes settings as validated environment variables, never through a shell.
- The dashboard only serves its own three static files, files the generator listed, and files inside `reports/`. It has path-traversal checks, a Host-header allow-list and a strict CSP.

## 10. Tests of the tool itself

```powershell
npm test
```

This runs **77 tests**:
- **Parser**: 43 requests discovered, folders, v2.0 formats, auth inheritance, invalid and non-collection JSON, variable precedence.
- **Converter**: every supported pattern, compound chains, unsupported statements never executed.
- **Generator**: syntax validity, no hardcoded endpoints, secrets moved, code-injection attempts, chaining detection.
- **Redaction**.
- **Server**: invalid JSON → 422 with line and column, 413/415 limits, path traversal, Host check, run-settings validation.
- **E2E**: against a local mock API (`tests/helpers/mock-api.js`, synthetic credentials). It covers the login → bearer token → create → id chain, an **intentionally failing assertion** reported as *Assertion failure*, an expected 404 that passes, a 500 reported as *HTTP error*, an unreachable host reported as *Network error*, OAuth2 → skipped, and **no secret** in generated code, logs, `summary.json`, the HTML report or the decoded Playwright report data.
- **Auth e2e** (`tests/auth-e2e.test.js`): against a local token API (`tests/helpers/auth-mock-api.js`) with a collection that has no scripts. It runs four scenarios:
  - **Valid credentials**: on-demand login, one login reused by several requests, 401 → refresh → retry, noauth/Basic/API-key overrides kept, and an expected-401 negative test that passes.
  - **Invalid credentials**: `auth-rejected`, protected requests not sent, login not repeated.
  - **Missing token or credential**: `auth-config` with the variable name and the `PM_VAR_` hint.
  - **Invalid config**: `auth-config`, and the literal credential is not echoed.

  Every scenario also checks that no password, API key or issued token appears in any output.
- **Auth config** (`tests/auth-config.test.js`): validation messages, credential rejection, request lookup by name or folder path (not by position), JSON paths.
- **Request count** (`tests/request-count.test.js`): collections with 0, 1, 10, 43 and 250 requests in nested folders are parsed, generated and summarized dynamically.

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| All tests fail with **Network error** | The host is unreachable from this machine. Check VPN/proxy/firewall, or point at a reachable environment with `TARGET_BASE_URL`. Example: `curl.exe -I https://your-host` |
| **Configuration problem: Unresolved variable(s)** | Upload the Postman environment, set `PM_VAR_<name>`, or make sure the request that extracts the value runs (and passes) first. |
| POST/PUT/PATCH/DELETE show **SKIP** | Mutating requests are blocked by default. Allow them only for test environments (`ALLOW_MUTATING_REQUESTS=true` or the dashboard checkbox). |
| A 4xx response **fails** a negative test | The collection has no expected status, so the baseline expects 2xx. Add `pm.response.to.have.status(4xx)` in Postman, save an example response with that code, or set `BASELINE_STATUS=non-5xx`. |
| Slow API → **Timeout** | Increase `REQUEST_TIMEOUT_MS` and `TEST_TIMEOUT_MS`. |
| Self-signed TLS certificate | `IGNORE_HTTPS_ERRORS=true` (test environments only). |
| Port 3000 is busy | `$env:PORT=3100; npm start` |
| `npm` blocked by PowerShell execution policy | Use `npm.cmd start`, or `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` (needs your IT policy's approval). |

## 12. Extending

- **New Postman assertion**: add a pattern in `assertion-converter.js` (`METHOD_OPS`, `STATUS_SHORTCUTS` or `resolveSubject`), emit code for it in `assertionCode()` in `playwright-generator.js`, and add a unit test.
- **New auth type**: add it to `SUPPORTED_AUTH` (parser), `buildAuth()` (generator) and `applyAuth()` (runtime).
- **New body mode**: `normalizeBody()` (parser), `buildBody()` (generator) and `buildBody()` (runtime).
- **Report sections**: `report-service.js` (`buildReportData` for data, `CLIENT_JS` for rendering).

## 13. Known limitations

- Automatic authentication supports a login request that returns JSON with a bearer token. OAuth2 authorization-code / PKCE flows, AWS SigV4, NTLM and Digest are not implemented.
- On-demand login/refresh calls are recorded as events in the report, but their own request and response bodies are not shown (they contain credentials).

- Only the patterns listed above are converted. Complex script logic is reported but not run.
- Runtime variable writes (`pm.collectionVariables.set` etc.) all go to a single highest-precedence runtime scope instead of Postman's separate scopes.
- No Postman data files (iterations), no `setNextRequest` flow control, no cookies jar management beyond Playwright's defaults.
- Form-data file fields must exist in `FILES_DIR` (`collections/files`).
- Response bodies in the report are redacted by key name (password, token, secret, apiKey, …) and by known secret values. Unusual field names that hold personal data are not detected; set `REPORT_INCLUDE_BODIES=false` if responses may contain sensitive data.
- One run at a time from the dashboard. The dashboard keeps the uploaded collection in memory until restart.

## 14. Verification log (2026-10-28)

- `api.jsonplaceholder.dev` (the host in the supplied collection) **was not reachable** from this machine: DNS resolved to 46.224.24.223, but the TCP connection to port 443 timed out. `jsonplaceholder.typicode.com` was reachable. With your approval, live runs use `TARGET_BASE_URL=https://jsonplaceholder.typicode.com`. The collection file itself is unchanged.
- Live run: **43 tests, 43 passed, 0 failed, 0 skipped** (about 11 s, 1 worker). typicode is a fake API: writes are simulated, not persisted.
- With `ALLOW_MUTATING_REQUESTS=false`: 19 passed, 24 skipped (all POST/PUT/PATCH/DELETE).
- `npm test`: 53 of 53 passed (first version).
- Automatic authentication update: `npm test` 77 of 77 passed. This adds the auth e2e scenarios (valid login + reuse + refresh, invalid credentials, missing token/config, invalid config), auth config unit tests, and dynamic request-count tests for 0, 1, 10, 43 and 250 requests.
