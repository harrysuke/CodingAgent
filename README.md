# CodingAgent

An OpenCode-style local coding agent: a Node.js/TypeScript agent engine, a Vue 3
chat workspace, and Tauri 2 shells for desktop and mobile. It **reuses the
SQLite model catalogue copied from `freellmapi`** (108 models, fallback
configuration, provider registry). Accounts and provider keys are local:
the shipped database is sanitized before packaging.

Everything runs on your machine. The UI talks to a localhost HTTP + SSE API;
no cloud service, no telemetry. **Accounts are local and BYOK**: everyone signs
in before any request is accepted, and every account can only spend its own
provider API keys. There is no shared access token and no shared quota.

---

## Architecture

```
D:\Nodejs\CodingAgent
├── data/codingagent.db          <- SQLite DB (renamed freeapi.db snapshot, or created on first run), GITIGNORED
├── packages/shared              <- Zod schemas + TS contracts (server & UI)
├── apps/server                  <- Hono HTTP/SSE + agent loop + workspace tools
│   ├── src/auth/                 scrypt passwords, account sessions, BYOK ownership
│   ├── src/workspace/            sandbox paths, file ops, folder browser, attachments
│   ├── src/terminal/             persistent shell sessions streamed over SSE
│   ├── src/skills/               SKILL.md registry, installer, prompt injection
│   └── dist/index.js             esbuild bundle (--packages=external)
├── apps/web                     <- Vue 3 + Vite + Pinia + Tailwind + Shiki
│   ├── src/views/AuthView.vue    sign-in / registration / first-run owner setup
│   └── dist                      served by Vite (dev) or Node (prod/desktop)
├── apps/desktop/src-tauri       <- Tauri 2 Rust shell (desktop + mobile)
│   ├── src/lib.rs                sidecar supervisor + IPC commands
│   └── resources/                generated portable runtime (gitignored)
│       ├── node/node.exe
│       └── server/{index.js,node_modules,.env,data,apps/web/dist,workspace}
└── scripts                      setup / packaging / smoke & runtime verification
```

```
 Tauri window (or browser)  ──HTTP + SSE──▶  Hono server  ──▶  SQLite (reused)
        Vue 3 + Pinia                          │
                                               ├─ Vercel AI SDK v5 (18 providers)
                                               ├─ tool loop (read/write/edit/bash/...)
                                               ├─ workspace sandbox (resolveSafe)
                                               ├─ attachments (explicit turn context)
                                               ├─ terminal (persistent shell, SSE)
                                               └─ Agent Skills (prompt + tool defaults)
```

### Open-source building blocks

| Concern | Library |
| --- | --- |
| LLM streaming, tool calls, `stopWhen` | `ai` (Vercel AI SDK v5) + `@ai-sdk/openai-compatible` |
| HTTP + SSE | `hono`, `@hono/node-server` |
| SQLite | `better-sqlite3` |
| Contracts / validation | `zod`, TypeScript |
| Workspace tools | `fast-glob`, `execa`, `ignore`, `diff` |
| UI | `vue`, `pinia`, `vue-router`, `tailwindcss`, `vite`, `lucide-vue-next` |
| Rendering | `marked`, `shiki` |
| Desktop / mobile | `tauri` 2, `@tauri-apps/api`, `@tauri-apps/cli` |

---

## Database provenance (important)

The source DB was `freellmapi_bak/server/data/freeapi.db` (plus `-wal`/`-shm`).
`npm run setup` copies it with SQLite `VACUUM INTO`, which folds the WAL into a
clean, integrity-checked snapshot at `data/codingagent.db`.

### First run on a fresh clone (no database yet)

`data/` is gitignored, so a repository downloaded from GitHub ships **no
database**. `initDb()` (called by both the server and `npm run db:migrate`)
handles that automatically, on every start:

1. create `data/` if it is missing;
2. create the inherited tables from `src/db/baseSchema.ts` (`CREATE TABLE IF NOT EXISTS`);
3. create the additive `agent_*` tables (`src/db/schema.ts`);
4. run the guarded `ALTER TABLE` upgrades (`user_id`, `session_id`, `agent`, ...);
5. seed a default project, global settings, and — only when `models` is empty —
   a 40-row default model catalogue plus a 5-slot fallback chain;
6. verify every required table exists and fail with a clear message if not.

All of it is idempotent, so the same code path upgrades an inherited snapshot
without touching user data. The server logs
`[db] Created <path> with N tables` the first time it builds a database. To
create the file without starting the server, run `npm run db:migrate`.

A brand-new database has no provider keys: sign in, then add your own under
**Settings → Providers & keys** (BYOK). `npm run smoke:fresh` exercises exactly
this path (empty temp directory → all tables + seeded catalog → idempotent rerun).

Inherited tables are used as-is: `models`, `api_keys`, `settings`,
`fallback_config`, `requests`, `embedding_models`, `users`, `sessions`,
`rate_limit_usage`, `rate_limit_cooldowns`.

Agent state is **additive** so nothing collides with the source schema (notably
its auth `sessions` table):

`projects`, `agent_sessions`, `agent_messages`, `agent_parts`,
`agent_permissions`, `agent_permission_grants`, `agent_todos`,
`agent_file_changes`, plus the account tables `agent_users`,
`agent_user_sessions`, `agent_user_settings`. `requests` gains `session_id`,
`agent` and `user_id` columns for telemetry.

`api_keys`, `projects`, `agent_sessions`, `agent_permissions` and `requests`
all carry a nullable `user_id`. Rows created before accounts existed stay
invisible until the first admin claims them; every query filters on `user_id`,
so a `NULL` row can never be reached by a regular account.
`agent:active_project` and all other preferences now live in
`agent_user_settings`, never in the global `settings` table.

> **Keep `ENCRYPTION_KEY` safe.** Provider keys are AES-256-GCM encrypted with
> the key in `.env`. `npm run setup` reads it from `freellmapi_bak/.env` into
> the new `.env`; if you lose it, pre-existing keys cannot be decrypted.
>
> **Never commit the database or a backup of it.** `.gitignore` excludes
> `*.db`, `*.db-wal`, `*.db-shm`, `*.sqlite*`, the whole `data/` runtime
> directory (including `.zip` DB backups), and `.env`. `data/codingagent.db`
> holds encrypted API keys, password hashes and chat history. Rotate the setup
> token with `npm run rotate:setup-token` before exposing a fresh server to a
> LAN.

---

## Accounts, login and BYOK

The old model (`AGENT_TOKEN` pasted into every client) is gone. Anyone who
reached the server could spend the owner's keys. Now:

| Stage | What happens |
| --- | --- |
| First run | `/api/auth/status` reports `needsSetup: true`. The UI shows a **Create owner account** form that requires the one-time setup token (`AGENT_TOKEN` from `.env`, or `<app-data>/server.env` on desktop). This stops a stranger on the LAN from registering first and claiming the owner's keys. |
| Owner account | Becomes the only admin. It claims every pre-existing unowned row (provider keys, projects, sessions, telemetry) so an upgrade does not lose data. |
| Later accounts | Register with an email + password (or are handed an account with `ALLOW_REGISTRATION=false`). They start with **zero provider keys**, their own settings, and a private workspace under `data/workspaces/<userId>`. |
| Every request | Carries a per-account bearer session token. Only that account's keys, projects, sessions, permissions, settings and usage are visible. A `401` clears the local session and returns to sign-in. |
| Model calls | `resolveCredential(platform, userId)` looks **only** in that account's key ring — there is no global fallback. With no usable key the chat shows a BYOK banner and the agent loop refuses the turn. |

Security details:

- Passwords use `scrypt` (`scrypt$<salt>$<hash>`) with `timingSafeEqual`.
- Session tokens are 32 random bytes; **only their SHA-256 hash** is stored, so a
  DB dump cannot be replayed as a live login. Changing a password invalidates
  every session for that account. Failed logins are throttled per process.
- `AGENT_TOKEN` is **not an API credential** any more. It is only the one-time
  first-admin setup secret (and the desktop sidecar's startup hint).
- Provider keys are AES-256-GCM encrypted, scoped by `api_keys.user_id`, and
  never returned in plaintext (only a masked preview).
- Non-admin accounts are confined to `data/workspaces/<userId>`. Workspace
  roots, project roots, attachments and tool paths all pass textual **and**
  realpath containment checks, so a symlink out to the host `.env` is refused.
- Shell access is **disabled by default** for non-admin accounts, because a
  shell can `cd ..` out of any in-process path sandbox. Set
  `AGENT_ALLOW_USER_SHELL=true` only if you fully trust every account.
- Terminal sessions carry their owner id; another account gets a 404.

Relevant `.env` settings (see `.env.example`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENT_TOKEN` | random from `npm run setup` | one-time first-admin setup secret |
| `ALLOW_REGISTRATION` | `true` | set `false` to close public sign-up |
| `AGENT_SESSION_TTL_DAYS` | `30` | login session lifetime |
| `USER_WORKSPACES_ROOT` | `./data/workspaces` | per-account sandbox root |
| `AGENT_ALLOW_USER_SHELL` | `false` | allow the terminal for non-admin accounts |

Auth endpoints: `GET /api/auth/status` (public), `POST /api/auth/register`,
`POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`,
`POST /api/auth/password`. `GET /api/health` is public but deliberately sparse
until authenticated (no DB path, no workspace path, no key counts).

---

## How to run

### Prerequisites

| Need | For |
| --- | --- |
| Node.js >= 20.19 (tested on 22) + npm | always |
| SQLite 3 CLI (`sqlite3` on PATH) | `npm run setup` (DB snapshot) |
| Rust toolchain + WebView2 | desktop build (`npm run desktop:*`) |
| Android SDK + NDK / Xcode | mobile builds only |

### 1. One-time setup

```bash
cd D:\Nodejs\CodingAgent
npm install
npm run setup      # copies freeapi.db -> data/codingagent.db and writes .env
```

`setup` is idempotent and inherits the source project's `ENCRYPTION_KEY`, which
is required to decrypt the provider keys already stored in the database. It also
writes a **fresh random `AGENT_TOKEN`** — save that line. On the first visit to
the app you will create the owner account with it, then add your own provider
keys under **Settings → Account / Providers & keys**.

If no source snapshot exists (the normal case after `git clone`), `setup` skips
the copy step: the server creates `data/codingagent.db` with every required
table on first start. Run `npm run db:migrate` if you want the file created
right away.

### 2. Run in the browser (development — the usual loop)

```bash
npm run dev
```

Open <http://localhost:5173>. Vite serves the Vue UI and proxies `/api` to the
agent server on **http://127.0.0.1:4317** (tsx watch, restarts on change). On a
fresh database the UI opens the owner-setup screen instead of the chat.

### 3. Run as a single-origin production server

```bash
npm run build
npm start
```

Open <http://127.0.0.1:4317> — Node serves both the API and the built UI. This
is also the server a phone or another machine connects to (see §5).

### 4. Run as a desktop app (Tauri 2)

```bash
npm run desktop:dev      # dev window; reuses the Vite dev server
npm run desktop:build    # real app + installer (release build)
```

- `desktop:build` first runs `scripts/prepare-desktop.mjs`, which assembles a
  self-contained runtime in `apps/desktop/src-tauri/resources/` (single-file
  server bundle, portable Node, DB snapshot, built UI), then compiles and
  bundles. Output lands in `apps/desktop/src-tauri/target/release/bundle/`.
- A packaged app spawns its own agent server and keeps your data in
  `%APPDATA%\com.codingagent.app` (`data\codingagent.db`, `workspace\`,
  `server.env`, `server.log`) — not in the install directory.
- A binary produced by `tauri build` (debug or release) is standalone: it starts
  and supervises its own server. Only `tauri dev` (and a bare `cargo build`)
  expects the Vite dev server from `npm run dev`.

### 5. Run on mobile (Tauri 2 Android / iOS)

The phone has no Node runtime, so point it at a server running on your machine:

```bash
# in .env on the host: HOST=0.0.0.0
npm start               # note the host LAN IP, e.g. 192.168.1.50:4317

npm run mobile:android:init    # needs Android SDK + NDK
npm run mobile:android:dev
# macOS + Xcode:
npm run mobile:ios:init && npm run mobile:ios:dev
```

In the app open **Settings → Connection**, set **Server URL** to
`http://192.168.1.50:4317`, then **sign in** (or register) in the app. You do
**not** paste `AGENT_TOKEN` — that is only for creating the very first admin
account. New accounts must add their own key under **Settings → Providers &
keys**. Allow port 4317 through the host firewall. Mobile never starts a
sidecar, so these settings are always used.

> Binding `0.0.0.0` exposes the login page to your LAN. Rotate the setup token
> first, and set `ALLOW_REGISTRATION=false` if you do not want new sign-ups.

### 6. Verify the install

```bash
npm run typecheck          # shared + server tsc, web vue-tsc
npm run smoke              # isolated server, 62 checks (accounts, BYOK, isolation, tools)
npm run smoke -- --chat --tools   # + live LLM turn and tool/permission flow (71 checks)
npm run verify:desktop     # boots the packaged runtime, 35 checks incl. privacy audit
npm run desktop:check      # cargo check the Rust shell
```

`npm run smoke` no longer needs a running server: it boots its own isolated
instance with a throwaway DB copy, a temporary workspace and a random setup
token, so the real database is never touched.

> **Setup-token gotcha:** `AGENT_TOKEN` is needed **once**, to create the first
> admin account. If it is still the shipped placeholder, rotate it with
> `npm run rotate:setup-token` and restart before anyone else can reach the
> server. After that, sign-in uses an email + password and a browser-held
> session token — there is no access token to paste into Settings.

### Scripts

| Command | What it does |
| --- | --- |
| `npm run setup` | Idempotent DB snapshot + `.env` generation |
| `npm run rotate:setup-token` | Replace `AGENT_TOKEN` with a fresh random secret |
| `npm run dev` | Server (tsx watch) + Vite dev server |
| `npm run build` | Build shared → server bundle → Vue app |
| `npm start` | Serve the built UI and API from Node |
| `npm run typecheck` | Shared + server `tsc` + `vue-tsc` |
| `npm run db:migrate` | Create the database + all tables if missing, then apply the additive `agent_*` schema |
| `npm run smoke` | 62 isolated API checks (accounts, BYOK, isolation, tools) |
| `npm run smoke:fresh` | 13 checks that a missing database is created with every table |
| `npm run smoke -- --chat --tools` | + live LLM streaming + permission/tool flow (71) |
| `npm run desktop:dev` | Tauri dev window (uses the Vite dev server) |
| `npm run desktop:build` | Assemble a **BYOK-only** runtime + build the installer |
| `npm run desktop:build:private` | Same, but keeps your encrypted keys (`--include-keys`) — **never redistribute** |
| `npm run desktop:check` | `cargo check` the Rust shell |
| `npm run verify:desktop` | Boot the *packaged* runtime, audit DB privacy, exercise its API |

---

## Agent features

- **Accounts + BYOK.** Local sign-in, a one-time owner setup token, per-account
  encrypted provider keys, per-account sessions/projects/settings/usage, and a
  private workspace sandbox for every non-admin account. See
  [Accounts, login and BYOK](#accounts-login-and-byok).
- **Workspace as a sandbox.** The folder button at the left of the composer's
  picker row (next to the model selectbox) opens an OpenCode-style browser: drive
  roots, breadcrumbs, git-repo badges, recents, and a manual path field. Opening a
  folder registers it as a project and makes it the agent's active root. Every
  tool path is resolved inside it — `..`, absolute paths outside the root and
  symlinks that point outside are all refused. Sessions are project-scoped, so a
  session always operates on the workspace it was born in.
- **Attachments as explicit context.** The paperclip (or drag-and-drop) pins
  files to a single message. Workspace files are read server-side; device files
  are read by the browser and inlined. Attachments are inlined into that turn
  only, capped at 256 KB/file and ~200k chars/turn, and are recorded on the user
  message as metadata chips (name, size, token estimate) so the transcript shows
  exactly what the model saw.
- **Terminal + Agent Skills.** A persistent shell runs in the workspace root and
  streams over SSE (`Ctrl+``). The Skills tab installs `SKILL.md` skills from a
  git URL, `owner/repo`, a local path or a built-in starter, then injects their
  instructions, tool allow-lists and per-tool defaults into the agent's system
  prompt on every turn.
- **Streaming chat** with SSE deltas, persisted messages and message parts
  (text, reasoning, tool calls, tool results, diffs, errors, attachments).
- **18 OpenAI-compatible providers** ported from the source project's provider
  registry (Groq, Cerebras, OpenRouter, Mistral, GitHub, Ollama, Cloudflare
  `account_id:api_token`, custom endpoints, keyless providers, …), with the
  inherited fallback chain.
- **Tools**: `read`, `write`, `edit` (exact-string), `bash`, `list`, `glob`,
  `grep`, `webfetch`, `todo`, `getTodos`, `skills`, `settings`. Paths are
  sandboxed with `resolveSafe`; binary files, path escapes and destructive shell
  patterns are blocked.
- **Permissions**: `ask` / `allow` / `deny`, always-allow grants scoped to a
  session, and a read-only **Plan** mode alongside **Build** / **General**.
- **UI**: session sidebar, workspace picker in the composer, model + mode pickers, tool-call
  cards, unified diffs, permission dialog, file tree, Changes / Plan panels,
  terminal + skills dock, attachment tray, markdown with lazy Shiki
  highlighting, usage analytics, provider-key manager, light/dark theme,
  responsive mobile layout.

Every `/api` endpoint except `health` and `auth/status|login|register` requires a
per-account bearer session; CORS stays open so Tauri and mobile WebViews can
reach a loopback/LAN server. Endpoints live under `/api`:
`auth/*`, `health`, `models`, `providers`, `keys`, `settings`, `analytics`, `projects`,
`workspace`, `workspace/browse`, `workspace/open`, `attachments/resolve`,
`skills`, `skills/install`, `skills/:id`, `terminal`, `terminal/:id/*`,
`sessions`, `sessions/:id/chat|abort|events|permissions`, `permissions/:id/resolve`,
`files/tree|content|changes`, `todos`.

---

## Workspace, attachments, terminal and Agent Skills

### 1. Workspace = the agent's sandbox root

`POST /api/workspace/open` validates the folder, reuses (or creates) a
user-owned `projects` row, and stores `agent:active_project` in
`agent_user_settings` for the signed-in account. From then on:

- new sessions attach to that project, and `rootFor()` / `activeRoot()` resolve
  every file tool against it;
- `resolveSafe` rejects `..`, absolute paths outside the root, and symlinks whose
  real target leaves the root;
- non-admin accounts can only open folders inside `data/workspaces/<userId>`;
  both textual and realpath containment are checked, so a symlink cannot widen
  the sandbox;
- `/api/workspace/browse` is a directory-only browser (drives on Windows, common
  roots elsewhere) so the picker works in a browser, the desktop shell and on a
  phone.

### 2. Attachments = explicit, per-turn context

The composer sends `attachments: [{ path, name?, external?, content? }]`. The
server reads each file itself (`workspace/attachments.ts`), rejects binaries,
truncates at 256 KB, and appends a delimited `<attached-files>` block to that
turn only — no whole-workspace scan, and no attachment content is persisted in
SQLite (only metadata + a 240-char preview).

### 3. Terminal + `SKILL.md` skills

The Skills tab writes to `<workspace>/.codingagent/skills/<slug>/SKILL.md`
(workspace scope) or `~/.codingagent/skills/` (user scope). Toggle state lives in
`<workspace>/.codingagent/skills.json`.

```markdown
---
name: Test First
description: Add or repair tests before changing production code.
version: 1.0.0
allowedTools: read, grep, glob, edit, write, bash
toolDefaults:
  bash.timeoutMs: 300000
  read.limit: 800
---

Work test-first on every behaviour change.
...
```

- `allowedTools` narrows the toolset exposed to the model (union across active
  skills; `skills`/`todo`/`settings` are always kept).
- `toolDefaults` fill arguments the model omitted (`read.limit`, `bash.timeoutMs`,
  `grep.max`, …).
- The body is injected under `## Installed Agent Skills (active)` in the system
  prompt, so it is standing guidance for the session, not a one-off message.
- Install sources: `https://…​.git`, `owner/repo`, `builtin:code-review`,
  `builtin:test-first`, or a local folder / `SKILL.md` path. The installer looks
  for `SKILL.md` at the root and up to two levels down, so a repo of skills
  installs all of them.

---

## Desktop (Tauri 2)

```bash
npm run desktop:dev      # dev window; Vite dev server + npm-run server
npm run desktop:build    # produces NSIS/MSI (Windows), dmg (macOS), deb/AppImage
```

`scripts/prepare-desktop.mjs` assembles a self-contained runtime under
`apps/desktop/src-tauri/resources/`: a **single-file esbuild bundle** of the
server (all JS dependencies inlined, only the native `better-sqlite3` addon kept
external), a **sanitized** DB snapshot, the built Vue app, a portable
`node.exe`/`node`, and a freshly generated `.env`. That keeps the resource tree
at ~370 files / ~23 MB instead of copying the whole dependency closure.

**The packaged database is stripped, and that is deliberate.** The source DB is
your live one: it contains chat history, usage telemetry, absolute project
paths, the inherited dashboard user's password hash + session tokens, and a
plaintext `unified_api_key`. The snapshot keeps only the model catalogue,
fallback config and harmless preference defaults, then runs `VACUUM` so purged
rows cannot be recovered from free pages. Provider keys are **not** shipped and
`ENCRYPTION_KEY` / `AGENT_TOKEN` are regenerated per build — an installer is
therefore BYOK-only and safe to hand to someone else. The first-run screen
prefills the fresh setup token, and the new owner adds their own key.

For a **private** build that keeps your own encrypted keys (and the source
`ENCRYPTION_KEY` needed to decrypt them), use `npm run desktop:build:private`
(`--include-keys`). Such an installer effectively contains your API keys — never
redistribute it. `npm run verify:desktop` audits the shipped DB for all of the
above and adapts its assertions to either build mode.

The packaging script also preflights the `better-sqlite3` native ABI. If npm
launched it with a Node built against a different `NODE_MODULE_VERSION`, it
re-execs under a compatible Node (or fails with a clear `CA_NODE_BIN` hint), so
the bundled `node.exe` can always load the addon.

On startup (every built binary, debug or release) `src/lib.rs`:

1. Creates a writable per-user app-data directory
   (`%APPDATA%\com.codingagent.app` on Windows,
   `~/Library/Application Support/com.codingagent.app` on macOS,
   `~/.local/share/com.codingagent.app` on Linux).
2. Seeds `server.env`, `data/codingagent.db` and `workspace/` from the bundled
   copies on first run. **Your sessions, keys and files live there**, not in the
   install directory. A stale `agent:active_project` from another machine is
   discarded at first-admin setup, so `WORKSPACE_ROOT` always wins.
3. Picks a free loopback port, spawns the bundled Node with real environment
   variables (`PORT`, `HOST`, `DB_PATH`, `WORKSPACE_ROOT`, `AGENT_TOKEN`,
   `ENCRYPTION_KEY` — dotenv never overrides them), and polls `/api/health`
   with a raw TCP probe.
4. Answers `get_server_config` with `{ url, token }`. The Vue client treats
   `token` as a **one-time setup-token hint** for the first-run owner screen,
   not as a bearer credential; after login all requests carry the account's
   session token. `get_server_status` exposes startup diagnostics. Server
   stdout/stderr goes to `<app-data>/server.log`.
5. Kills the child on application exit.

`tauri dev` skips the sidecar and uses the Vite proxy (detected through the
`dev` cfg emitted by tauri-build). To force the sidecar in dev, set
`CODINGAGENT_FORCE_SIDECAR=1`. Edit `<app-data>/server.env` to change the setup
token or encryption key, then restart the app — existing sessions are unaffected.

---

## Mobile (Tauri 2 Android / iOS)

Mobile has no Node runtime. The Vue app instead connects to a **desktop or LAN
server** you already run:

```bash
# On the host machine (.env), then restart the server:
HOST=0.0.0.0               # bind the LAN interface
ALLOW_REGISTRATION=false    # optional: only hand out accounts yourself

npm start                  # note the host LAN IP, e.g. 192.168.1.50:4317
```

CORS is already permissive (the server replies `Access-Control-Allow-Origin: *`
to authenticated API calls), so no extra origin configuration is needed.

Then, in the app: **Settings → Connection → Server URL** =
`http://192.168.1.50:4317`, and sign in with your account. Each account must
add its own key under **Settings → Providers & keys**. The Rust
`get_server_config` command returns `null` on mobile, so the saved settings are
always used. Hash routing, fetch-based SSE (with `Authorization` header) and
safe-area padding are all mobile-friendly.

```bash
npm run mobile:android:init   # tauri android init (Android SDK + NDK required)
npm run mobile:android:dev    # tauri android dev
npm run mobile:android:build  # tauri android build
npm run mobile:ios:init       # tauri ios init  (macOS + Xcode required)
npm run mobile:ios:dev
```

The generated `src-tauri/gen/android` / `gen/ios` projects are gitignored.

---

## Verification performed

| Check | Result |
| --- | --- |
| `PRAGMA integrity_check` on `codingagent.db` | `ok` |
| Migration | additive account/ownership tables, 108 models, account-scoped keys |
| `npm run typecheck` | pass (shared `tsc`, server `tsc`, web `vue-tsc`) |
| `npm run build` | pass (shared + server bundle + Vue dist) |
| `npm run smoke` | **62 passed / 0 failed** — isolated DB/workspace/port, first-admin setup, two-account isolation, BYOK, workspace, attachments, skills, terminal |
| `npm run smoke -- --chat --tools` | **71 passed / 0 failed** — live LLM stream, permission → `write` → diff recorded |
| Multi-user isolation | second account sees 0 owner keys/models/sessions, gets 404 on owner chat/SSE, cannot escape its workspace, cannot spawn a shell, can add its own key |
| `npm run verify:desktop` | **35 passed / 0 failed** — packaged Node + server + sanitized DB, privacy audit, first-admin setup, BYOK end to end |
| `npm run verify:desktop` against `--include-keys` build | **33 passed / 0 failed** — private key-bearing build, adaptive assertions |
| `npm run desktop:check` | pass (only two harmless Windows incremental-lockfile warnings) |
| `tauri build --debug --no-bundle` | previously pass; produced `target/debug/codingagent.exe` |
| Live turn with attachment + skill | model read the attached `package.json` and the injected `Test First` skill; user turn persisted `text` + `attachment` parts |

### Troubleshooting

- **`ENCRYPTION_KEY must be 64 hex chars`** — restore the key from
  `freellmapi_bak/.env` into `.env` (or `<app-data>/server.env`) and restart.
  Keys added on a desktop build are encrypted with that build's own fresh key,
  so do not point a desktop install at the source project's database.
- **Native addon error** — `npm rebuild better-sqlite3 --foreground-scripts`.
  On machines with several Node versions, `scripts/smoke-test.mjs` auto-detects
  one whose ABI matches the compiled addon (or set `CA_NODE_BIN`).
- **"Your session has expired" / bounced back to sign-in** — log in again; the
  30-day session TTL elapsed, the password was changed, or the server was
  restarted against a different database.
- **Stuck on "Create owner account"** — enter the `AGENT_TOKEN` from `.env`
  (or `<app-data>/server.env` on desktop). If it is still
  `change-me-local-dev-token`, run `npm run rotate:setup-token` and restart.
- **Sign-in screen says the server is out of date** — an old `dist` is still
  being served and has no `/api/auth/*` routes. Rebuild (`npm run build`) and
  restart; check that nothing stale is holding port 4317.
- **"Add your own API key" banner / chat refuses to start** — BYOK is working as
  intended. Add a key under **Settings → Providers & keys** and pick a model
  from that provider.
- **Desktop window is blank / offline** — check `<app-data>/server.log`; the
  sidecar readiness timeout is 30 s, `get_server_config` waits up to 20 s.
- **Mobile cannot connect** — the server must bind `0.0.0.0`, the phone must be
  on the same network, and the firewall must allow port 4317. Use HTTPS or a
  tunnel for access over the public internet.
- **Installer build is large** — it embeds a portable Node runtime (~83 MB) and
  the bundled server (~23 MB, mostly the Vue UI and Shiki grammars) so no system
  Node is required.
- **`RC2176: old DIB`** while building on Windows — `icon.ico` is malformed. Run
  `node scripts/make-icons.mjs` to regenerate a DIB-based icon set that
  `rc.exe` accepts.
