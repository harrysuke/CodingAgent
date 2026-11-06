# Coding-Agent Architectures — Comparative Research

**Date:** 2026-11-05
**Scope:** OpenCode, Cline, Aider, Continue, Goose, with Claude Code as the sandboxing reference point.
**Dimensions:** sandbox & path confinement · permission model · skill/plugin registry · context strategy · streaming & session UX.
**Evidence basis:** primary vendor documentation only (links in References). No secondary blog aggregation was used for any factual claim below.

---

## 1. Executive summary

Five structural decisions separate these agents, and they are largely independent of each other:

1. **Confinement is expressed as a path boundary, not a sandbox.** Every tool except Claude Code treats "the project worktree" as the security boundary and enforces it through *permissions*, not the OS. OpenCode is explicit about this: `external_directory` is a permission key, and there is no documented container, filesystem jail, or network sandbox anywhere in its permission or agent docs.
2. **Claude Code is the outlier because it enforces at the OS layer.** Seatbelt (macOS) / bubblewrap (Linux, WSL2) restrict the *running process*; permission rules gate *before* execution. The docs state the principle directly: rules are "advisory pre-execution gating; the OS sandbox is hard enforcement during execution." Notably, **native Windows gets no sandbox at all** — the documented workaround is to run inside WSL2.
3. **The permission engine converges on one design: per-tool key → `allow` / `ask` / `deny`, with glob patterns and last-match-wins.** OpenCode, Claude Code and Goose all landed here independently. OpenCode's is the cleanest to copy because it keys on *tool name* uniformly, which makes MCP tools and built-in tools obey the same matcher.
4. **Skills are moving from "inject into the prompt" to "advertise then load on demand."** OpenCode lists only `name` + `description` in the `skill` tool description and fetches the body only when the model calls `skill({name})`. That is progressive disclosure, and it is the single cheapest token win available.
5. **Git is the undo primitive; context is a budgeted ranking problem.** Aider commits every edit (and pre-commits dirty files) so `/undo` is free, and its repo map is a tree-sitter symbol graph ranked to fit a **1k-token default budget** (`--map-tokens`), expanding dynamically when no files are in chat. Nobody else ships as disciplined a context budget.

The uncomfortable finding for a path-confinement design like CodingAgent's: **`resolveSafe`-style checks are a correctness feature, not a security boundary.** They stop the model from *accidentally* leaving the workspace. They do not stop a shell command that is itself malicious, because the shell is not path-checked. Only OS-level isolation closes that gap, and on Windows there is no seatbelt equivalent.

---

## 2. Item-by-item

### 2.1 OpenCode — the reference architecture for a client/server agent

**Agent tiers.** Two-tier: *primary* agents (`build` = all tools, `plan` = restricted) and *subagents* (`general`, `explore` = fast read-only), plus three hidden system primaries (`compaction`, `title`, `summary`). Defined either in `opencode.json` under `agent`, or as Markdown with YAML frontmatter in `.opencode/agents/` or `~/.config/opencode/agents/`. Frontmatter keys: `description` (required), `mode` (`primary|subagent|all`), `model`, `prompt` (`{file:...}`), `temperature`, `top_p`, `steps`, `hidden`, `permission`, `color`.

**Permission engine.** `allow` / `ask` / `deny`, keyed by tool name: `read`, `edit`, `glob`, `grep`, `list`, `bash`, `task`, `todowrite`, `skill`, `lsp`, `question`, `webfetch`, `websearch`, `external_directory`, `doom_loop`.

- Patterns are wildcard matches (`*`, `?`), and **the last matching rule wins** — catch-all first, specifics after.
- Granular objects allow command-level control: `{"bash": {"*": "ask", "git *": "allow", "rm *": "deny"}}`.
- `external_directory` gates *any* tool touching paths outside the worktree; `~`/`$HOME` expansion is supported but **does not make the path part of the workspace**.
- Defaults are permissive: most keys `allow`; `doom_loop` and `external_directory` are `ask`; `read` is `allow` **except `.env` / `*.env.*` which are `ask`** (`.env.example` stays allowed). That `.env` carve-out is a good default to steal verbatim.
- `ask` resolves to `once` / `always` / `reject`, where `always` re-uses a tool-supplied pattern set (bash typically whitelists a safe command prefix).
- `--auto` auto-approves everything not explicitly denied. `doom_loop` fires when the same tool call repeats 3× with identical input — a stuck-agent guard worth copying.

**Skills.** `.opencode/skills/<name>/SKILL.md`, plus Claude-compatible `.claude/skills/` and `.agents/skills/` paths, project and global. Discovery **walks up from cwd to the git worktree**. Frontmatter: `name` (1–64 chars, `^[a-z0-9]+(-[a-z0-9]+)*$`, must equal directory name), `description` (1–1024), optional `license`, `compatibility`, `metadata`. The agent sees an `<available_skills>` block in the `skill` tool description and loads bodies on demand. `permission.skill` accepts wildcards (`internal-*`: `deny`), and `tools: {skill: false}` removes the block entirely.

**Server/UX.** `opencode serve` runs a headless HTTP server (default `127.0.0.1:4096`) publishing an **OpenAPI 3.1 spec at `/doc`**; the TUI is just a client, and the IDE plugins drive it through `/tui/*` endpoints. Streaming is **SSE at `/event`**, whose first event is `server.connected`. Sessions support `parentID` (subagent trees), `fork` at a message, `revert`/`unrevert`, `diff` per session, `summarize`, `abort`, and `POST /session/:id/permissions/:permissionID` with `{response, remember}` — i.e. **the approval prompt is a first-class API object**, which is what makes remote/mobile clients possible.

### 2.2 Cline — the mode split as a product feature

Plan mode is read-only by construction: it "can read your codebase, run searches, and discuss strategy, but cannot modify any files or execute commands." Act mode retains the full plan-mode context, so switching modes does not lose history. Both modes can be pinned to **different models** (strong reasoning for Plan, fast model for Act) — a cost lever that is orthogonal to permissions. `/deep-planning` runs an extended exploration that enumerates affected files and dependencies and asks clarifying questions before acting; the prompt is tuned per model family. Checkpoints are the rollback mechanism (git-backed), recommended to be enabled *before* Act.

**Takeaway:** the mode is a UX/context device, not a security device. Plan mode is enforced by the tool layer, but the docs frame it as focus, not safety.

### 2.3 Aider — context budget and git as the safety net

**Repo map.** Tree-sitter extracts class/function/type definitions with signatures across the whole repo; the result is a graph where files are nodes and dependencies are edges, ranked so that the **most-referenced symbols** survive truncation. The budget is `--map-tokens`, **default 1k**, adjusted dynamically — it "will usually stay within that setting's value" but "does expand significantly at times, especially when no files have been added to the chat." The map is sent with *every* change request. The stated benefit is dual: often the map alone is enough context, and when it isn't, the model uses the map to decide which files to request.

**Git integration.** Aider commits every edit with a model-generated message (Conventional Commits by default, via `--weak-model`). Crucially, **it commits pre-existing dirty files first**, so user work and agent work stay separate. `/undo`, `/diff`, `/commit`, `/git` are in-chat commands. It skips pre-commit hooks by default (`--no-verify`) unless `--git-commit-verify`. Commits are attributed with `(aider)` in author/committer metadata.

**Takeaway:** per-edit commits turn "undo" into a solved problem with zero custom infrastructure, and the dirty-file pre-commit is the detail most implementations miss.

### 2.4 Continue — configuration surface over mechanism

Customization is organized as: **model providers** + **model roles** (a different model per feature — chat vs. autocomplete vs. apply), **rules**, **prompts** (custom slash commands), and **MCP tools** for the agent. Config lives in `config.yaml`, edited from the chat sidebar. Continue's differentiation is breadth of provider/role configurability rather than a novel sandbox or permission model.

*Caveat:* the deep-dive context page returned 404 at fetch time, so this item is deliberately thinner than the others — I did not infer an indexing design I could not source.

### 2.5 Goose — MCP as the only extension primitive

Every extension **is** an MCP server, including the built-ins (`Developer`, `Computer Controller`, `Memory`, `Analyze`, `Skills`, `Summon`, `Todo`, `Top of Mind`, `Extension Manager`). Built-ins are reusable outside Goose. Installation via directory, UI modal, CLI flags (`--with-builtin`, `--with-extension`, `--with-streamable-http-extension`), `goose://extension?...` deeplinks (cmd restricted to `jbang`, `npx`, `uvx`, `goosed`, `docker`), or `~/.config/goose/config.yaml`. **MCP Roots** lets roots-aware extensions see the session working directory — the MCP-native equivalent of a workspace root.

**The permission default is the opposite of OpenCode's:** "goose operates autonomously by default… goose can execute commands and modify files without your approval." Control is opt-in via permission mode and per-tool permissions. External extensions are malware-scanned before activation. Extensions can be enabled mid-session and auto-suggested when a task needs a missing capability, scoped to the session unless persisted.

**Takeaway:** MCP-only extensibility buys ecosystem reuse at the cost of a uniform, coarse permission surface; the autonomous default is a deliberate product stance, not an oversight.

### 2.6 Claude Code — OS-level enforcement, and its seams

- **Sandbox scope:** Bash/PowerShell/Monitor and their children only. **Off by default.** macOS Seatbelt, Linux/WSL2 bubblewrap (+ optional seccomp for Unix-socket blocking), via `@anthropic-ai/sandbox-runtime`. Native Windows: unsandboxed; use WSL2.
- **Filesystem:** writes allowed to cwd + per-user temp + added dirs; **reads allowed across most of the machine including `~/.ssh`, `~/.aws/credentials`** unless explicitly denied. `denyRead` beats a wider `allowRead` ("a deny holds inside a wider allow"). `permissions.blockReadsOutsideWorkingDirectories` is the blunt instrument.
- **Protected paths:** writes denied to `.claude` settings/skills/agents/hooks, `.mcp.json`, shell rc files, `.gitconfig`, `.git/hooks`, `.git/config`, git `HEAD`/`objects`/`refs`, `~/.claude`, `.credentials.json`. Rationale is explicit and worth internalizing: a command that could edit those files **could grant itself permissions or install a hook that runs outside the sandbox**.
- **Network:** no direct route; traffic forced through an out-of-sandbox proxy via `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`. Allowlist starts empty. Loopback/link-local/metadata (`169.254.169.254`) refused after allowlist pass — an SSRF guard. Non-proxy tools (`ssh`, most DB drivers) cannot connect even to allowed hosts. TLS is **not** inspected by default.
- **Two orthogonal systems:** permission modes decide *whether* a call runs; sandbox modes decide *what it can touch once running*. `sandbox.autoAllowBashIfSandboxed` approves sandboxed Bash with no prompt and is independent of permission mode. The `dangerouslyDisableSandbox` retry is the escape hatch, killed by `allowUnsandboxedCommands: false`.
- **Hooks/MCP/statusline/`apiKeyHelper` run outside the sandbox** with full access — the documented mitigation is to containerize the whole Claude Code process.
- **Precedence:** user / project / local / managed / `--settings`. `sandbox.failIfUnavailable: true` refuses to start rather than silently degrade. When admin-required, repo settings that *loosen* the sandbox are ignored, and `filesystem.disabled` can only be set by managed settings — "a checked-out project can't switch filesystem isolation off." That is the single most transferable governance idea in the entire corpus.

---

## 3. Cross-cutting comparison

| | OpenCode | Cline | Aider | Continue | Goose | Claude Code |
|---|---|---|---|---|---|---|
| **Confinement** | worktree + `external_directory` permission | VS Code workspace, tool-gated | cwd, git-tracked | IDE workspace | session dir via MCP Roots | OS sandbox (Seatbelt/bwrap) |
| **Permission model** | `allow/ask/deny`, glob, last-match-wins, per-agent | Plan/Act + auto-approve | none (git as safety net) | config-level | per-tool, **autonomous by default** | rules + modes + sandbox auto-allow |
| **Extensibility** | agents + skills + MCP + plugins | MCP | none (CLI flags) | MCP + rules + prompts | **MCP only** | skills, hooks, MCP, plugins |
| **Context strategy** | tools (grep/glob/lsp), on-demand skills | file reads + mentions | **tree-sitter repo map, 1k default** | providers + roles | extension-provided | tools + skills |
| **Undo** | session `revert`/`unrevert`, fork | checkpoints (git) | **per-edit commit + `/undo`** | n/a | n/a | git |
| **Client/server** | **HTTP + OpenAPI + SSE** | in-extension | single CLI | IDE extension | CLI + desktop | CLI/IDE |
| **Approval as API object** | yes (`/permissions/:id`) | UI-only | no | no | UI-only | UI-only |

---

## 4. What this means for CodingAgent

Mapped to what exists today (workspace `resolveSafe`, attachments, prompt-less terminal over SSE, `SKILL.md` registry that injects instructions + tool allow-lists into the system prompt).

**P1 — Stop injecting full skill bodies into the system prompt.** Adopt OpenCode's progressive disclosure: emit only `<available_skills><skill><name/><description/></skill></available_skills>` and add a `skill(name)` tool that returns the body. The current design pays full token cost for every installed skill on every turn; this makes cost scale with *skills used*, not *skills installed*. Validation rules are already specified above and cheap to enforce (`^[a-z0-9]+(-[a-z0-9]+)*$`, name must equal directory name).

**P2 — Replace boolean tool allow-lists with a real matcher.** `allow | ask | deny` × tool-name glob × **last-match-wins**, plus granular objects for `bash` command prefixes and `edit` path globs. Two defaults worth copying exactly: `external_directory` → `ask`, and `read` of `.env` / `*.env.*` → `ask` while `.env.example` stays `allow`. Add `doom_loop` (same call 3× → interrupt); it is a few lines and prevents the most expensive failure mode.

**P3 — Make the approval prompt a server-side object, not a modal.** OpenCode exposes `POST /session/:id/permissions/:permissionID` with `{response, remember}`. Because CodingAgent already streams over SSE, an approval should be a normal event on the existing stream and a normal POST back. This is what makes the mobile/Tauri clients viable later — a blocking `window.confirm` does not survive a remote transport.

**P4 — Treat "plan mode" as a permission preset, not a second code path.** `plan` = `{edit: deny (except plans/), bash: inherited, question: allow}`. Cline proves the UX value (separate models per mode, retained context); OpenCode proves it can be pure config. Do not build a parallel executor.

**P5 — Adopt git-per-turn before building custom checkpoints.** Auto-commit each successful turn with a generated message, **pre-committing dirty files first**, and expose undo as `git reset`. Aider's entire rollback story is this. It also gives the diff view for free (`/session/:id/diff` equivalent).

**P6 — Be honest in the UI about what `resolveSafe` is.** It prevents accidental escapes and is a genuine correctness win, but a shell command is not path-checked, so it is not a sandbox. Two options: (a) label it "workspace confinement" and stop implying isolation; (b) add a real boundary. On Windows there is no Seatbelt analogue — the realistic paths are WSL2 (bubblewrap, as Claude Code does) or a container. Note that Claude Code's own protected-paths list exists *because* hooks and config files are the escalation seam; a Node server that writes its own config is exposed to the same class of attack.

**P7 — Skip embeddings and skip the repo map for now.** Aider's map is the right answer *at scale*, but it is a tree-sitter + graph-ranking project, and its default budget is only 1k tokens — the win comes from ranking, not from volume. Below roughly a few hundred files, `grep`/`glob`/`lsp` tools plus a cheap symbol index dominate. Revisit only when tool-call counts show the agent wandering.

---

## 5. Uncertainties and conflicts

- **Landlock:** the request mentioned it; Claude Code's docs name only bubblewrap on Linux. Do not claim Landlock support without a primary source.
- **Continue's context internals:** the deep-dive page 404'd; the indexing/embeddings design is unverified here. Treat §2.4 as a config-surface description only.
- **"Sandbox" is used loosely in the ecosystem.** Only Claude Code's usage is OS-enforced. Where other projects say "sandbox," read "path boundary enforced by tool code."
- **Goose autonomy default vs. safety:** the docs are explicit that file writes and command execution need no approval by default. That is a product decision, but it makes Goose a poor template for a safety-first design.
- **Version drift:** OpenCode v2 is announced as available; permission docs are marked as of `v1.1.1` with the legacy `tools` boolean deprecated. Behavior may differ across v1/v2.

---

## References

- [OpenCode — Agents](https://opencode.ai/docs/agents/)
- [OpenCode — Permissions](https://opencode.ai/docs/permissions/)
- [OpenCode — Agent Skills](https://opencode.ai/docs/skills/)
- [OpenCode — Server API](https://opencode.ai/docs/server/)
- [Cline — Plan & Act Mode](https://docs.cline.bot/core-workflows/plan-and-act)
- [Aider — Repository map](https://aider.chat/docs/repomap.html)
- [Aider — Git integration](https://aider.chat/docs/git.html)
- [Continue — Customization Overview](https://docs.continue.dev/customize/overview)
- [Goose — Using Extensions](https://block.github.io/goose/docs/getting-started/using-extensions)
- [Claude Code — Sandboxing](https://docs.claude.com/en/docs/claude-code/sandboxing)
