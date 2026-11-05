# CodingAgent

An OpenCode-style local coding agent: a Node.js/TypeScript agent engine, a Vue 3
chat workspace, and Tauri 2 shells for desktop and mobile. It **reuses the
SQLite database copied from `freellmapi`**, so the
108-model catalogue, 16 encrypted provider keys, fallback configuration and
usage history all come along for the ride.

Everything runs on your machine. The UI talks to a localhost HTTP + SSE API;
no cloud service, no account, no telemetry.

---

## Architecture

```
D:\Nodejs\CodingAgent
├── data/codingagent.db          <- renamed copy of freeapi.db (VACUUM INTO)
├── packages/shared              <- Zod schemas + TS contracts (server & UI)
├── apps/server                  <- Hono HTTP/SSE + agent loop + workspace tools
│   ├── src/workspace/            sandbox paths, file ops, folder browser, attachments
│   ├── src/terminal/             persistent shell sessions streamed over SSE
│   ├── src/skills/               SKILL.md registry, installer, prompt injection
│   └── dist/index.js             esbuild bundle (--packages=external)
├── apps/web                     <- Vue 3 + Vite + Pinia + Tailwind + Shiki
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

Inherited tables are used as-is: `models`, `api_keys`, `settings`,
`fallback_config`, `requests`, `embedding_models`, `users`, `sessions`,
`rate_limit_usage`, `rate_limit_cooldowns`.

Agent state is **additive** so nothing collides with the source schema (notably
its auth `sessions` table):

`agent_sessions`, `agent_messages`, `agent_parts`, `agent_permissions`,
`agent_permission_grants`, `agent_todos`, `agent_file_changes`, `projects`.
`requests` gains `session_id` / `agent` columns for telemetry.

> **Keep `ENCRYPTION_KEY` safe.** The 16 provider keys in the copied DB are
> AES-256-GCM encrypted with the source project's key. `npm run setup` reads
> that key from `freellmapi_bak/.env` into the new `.env`. If you lose it, the
> keys cannot be decrypted — back it up before rotating.

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
is required to decrypt the 16 provider keys already stored in the database.

### 2. Run in the browser (development — the usual loop)

```bash
npm run dev
```

Open <http://localhost:5173>. Vite serves the Vue UI and proxies `/api` to the
agent server on **http://127.0.0.1:4317** (tsx watch, restarts on change).

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
# in .env on the host: HOST=0.0.0.0  (and optionally a long AGENT_TOKEN), then:
npm start               # note the host LAN IP, e.g. 192.168.1.50:4317

npm run mobile:android:init    # needs Android SDK + NDK
npm run mobile:android:dev
# macOS + Xcode:
npm run mobile:ios:init && npm run mobile:ios:dev
```

In the app open **Settings → Connection**, set **Server URL** to
`http://192.168.1.50:4317` and paste the same `AGENT_TOKEN`. Allow port 4317
through the host firewall. Mobile never starts a sidecar, so these settings are
always used.

### 6. Verify the install

```bash
npm run typecheck          # shared + server tsc, web vue-tsc
npm run smoke              # 16 API checks against the running server
npm run smoke -- --chat --tools   # + live LLM turn and tool/permission flow
npm run verify:desktop     # boots the packaged runtime, 13 checks
npm run desktop:check      # cargo check the Rust shell
```

> **Token gotcha:** the UI authenticates with `AGENT_TOKEN` (default
> `change-me-local-dev-token`). If you change it in `.env`, also update it in
> **Settings → Connection**. The desktop app injects it automatically.

### Scripts

| Command | What it does |
| --- | --- |
| `npm run setup` | Idempotent DB snapshot + `.env` generation |
| `npm run dev` | Server (tsx watch) + Vite dev server |
| `npm run build` | Build shared → server bundle → Vue app |
| `npm start` | Serve the built UI and API from Node |
| `npm run typecheck` | Shared + server `tsc` + `vue-tsc` |
| `npm run db:migrate` | Apply the additive `agent_*` schema |
| `npm run smoke` | 16 API smoke checks |
| `npm run smoke -- --chat --tools` | Live LLM streaming + permission/tool flow |
| `npm run desktop:dev` | Tauri dev window (uses the Vite dev server) |
| `npm run desktop:build` | Assemble runtime + build the desktop installer |
| `npm run desktop:check` | `cargo check` the Rust shell |
| `npm run verify:desktop` | Boot the *packaged* runtime and exercise its API |

---

## Agent features

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

The API is token-gated (`AGENT_TOKEN`) and CORS-open so Tauri and mobile
WebViews can reach a loopback/LAN server. Endpoints live under `/api`:
`health`, `models`, `providers`, `keys`, `settings`, `analytics`, `projects`,
`workspace`, `workspace/browse`, `workspace/open`, `attachments/resolve`,
`skills`, `skills/install`, `skills/:id`, `terminal`, `terminal/:id/*`,
`sessions`, `sessions/:id/chat|abort|events|permissions`, `permissions/:id/resolve`,
`files/tree|content|changes`, `todos`.

---

## Workspace, attachments, terminal and Agent Skills

### 1. Workspace = the agent's sandbox root

`POST /api/workspace/open` validates the folder, reuses (or creates) the
`projects` row, and stores `agent:active_project` in `settings`. From then on:

- new sessions attach to that project, and `rootFor()` / `activeRoot()` resolve
  every file tool against it;
- `resolveSafe` rejects `..`, absolute paths outside the root, and symlinks whose
  real target leaves the root;
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
external), a clean DB snapshot, the built Vue app, a portable `node.exe`/`node`,
and the `.env`. That keeps the resource tree at ~370 files / ~23 MB instead of
copying the whole dependency closure.

On startup (every built binary, debug or release) `src/lib.rs`:

1. Creates a writable per-user app-data directory
   (`%APPDATA%\com.codingagent.app` on Windows,
   `~/Library/Application Support/com.codingagent.app` on macOS,
   `~/.local/share/com.codingagent.app` on Linux).
2. Seeds `server.env`, `data/codingagent.db` and `workspace/` from the bundled
   copies on first run. **Your sessions and files live there**, not in the
   install directory.
3. Picks a free loopback port, spawns the bundled Node with real environment
   variables (`PORT`, `HOST`, `DB_PATH`, `WORKSPACE_ROOT`, `AGENT_TOKEN`,
   `ENCRYPTION_KEY` — dotenv never overrides them), and polls `/api/health`
   with a raw TCP probe.
4. Answers `get_server_config` with `{ url, token }`; the Vue client stores that
   and uses it for every request. `get_server_status` exposes startup
   diagnostics. Server stdout/stderr goes to `<app-data>/server.log`.
5. Kills the child on application exit.

`tauri dev` skips the sidecar and uses the Vite proxy (detected through the
`dev` cfg emitted by tauri-build). To force the sidecar in dev, set
`CODINGAGENT_FORCE_SIDECAR=1`. Edit `<app-data>/server.env` to
change the token or encryption key, then restart the app.

---

## Mobile (Tauri 2 Android / iOS)

Mobile has no Node runtime. The Vue app instead connects to a **desktop or LAN
server** you already run:

```bash
# On the host machine (.env), then restart the server:
HOST=0.0.0.0               # bind the LAN interface
AGENT_TOKEN=<a-long-random-secret>

npm start                  # note the host LAN IP, e.g. 192.168.1.50:4317
```

CORS is already permissive (the server replies `Access-Control-Allow-Origin: *`
to token-gated API calls), so no extra origin configuration is needed.

Then, in the app: **Settings → Connection → Server URL** =
`http://192.168.1.50:4317` and the same access token. The Rust
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
| Migration | 19 tables, 108 models, 16 keys, 1 default project |
| `npm run smoke` | 29 passed / 0 failed (includes workspace, attachment, skill and terminal checks) |
| `npm run smoke -- --chat` | 33 passed / 0 failed; live Groq stream, 53 SSE events |
| `npm run smoke -- --chat --tools` | 34 passed / 0 failed; permission → `write` → diff recorded |
| Live turn with attachment + skill | model read the attached `package.json` and the injected `Test First` skill; user turn persisted `text` + `attachment` parts |
| `npm run typecheck`, `npm run build` | pass |
| `cargo check` (Rust shell) | pass, no warnings |
| `tauri build --debug --no-bundle` | pass; produced `target/debug/codingagent.exe` |
| `npm run verify:desktop` | 13 passed / 0 failed; bundled Node + single-file server + copied DB |
| `npm run verify:desktop` | packaged Node + bundled server + copied DB, full API |

### Troubleshooting

- **`ENCRYPTION_KEY must be 64 hex chars`** — restore the key from
  `freellmapi_bak/.env` into `.env` (or `<app-data>/server.env`) and restart.
- **Native addon error** — `npm rebuild better-sqlite3 --foreground-scripts`.
- **Unauthorized in the UI** — the token in Settings → Connection must equal
  `AGENT_TOKEN` / `<app-data>/server.env`.
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
