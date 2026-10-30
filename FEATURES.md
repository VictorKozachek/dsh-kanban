# dsh-kanban features

[Русская версия](FEATURES.ru.md) · state as of 2026-10-30 (main, DSH 0.2.1-rc.3)

**What it is.** A Kanban board for agent tasks in the DeepSeek Harness right
sidebar. Task state lives in `.kanban/tasks/*.md` inside the project's git
repository: the board reads those files and shows them to humans, while the
plugin's host half watches them and dispatches **work notices** to agent
sessions. Several roles — dispatcher, executors, reviewer, verifier — work
against one board without chatting with each other.

## 1. Board in the GUI (client half)

- **"Kanban" tab** in the right sidebar with 8 columns:
  `backlog → todo → in-progress → in-review → testing → ready → merged`
  plus `blocked`.
- **A card** shows its id, title, role and owner (session id), an **"in branch"**
  badge (the task is not merged yet and the card was read from
  `worktrees/<id>`), token spend with a per-role breakdown, the note, time and
  the linked spec. Cards inside a column are sorted by id; a backlog card
  without an owner is labelled "unassigned".
- **Details panel** on click: task description, tokens per role, session
  (role · owner), `spec`, and all role comments in order of appearance.
- **Human in the loop:** mouse drag **only between `backlog` and `todo`**, plus
  duplicate buttons "→ To work" / "← To backlog". Forward is assignment: the
  card gets an owner and the executor is woken by a notice. Back is allowed only
  from `todo` and clears the owner and role. Other columns are moved by agents
  only: dropping there answers "this card is moved by agents only".
- **Move states:** "moving…" while the request is in flight, the board is
  re-read on success, and a banner shows the host's refusal text ("all
  executors are busy", "card is in status …") or "channel unavailable" when
  disconnected.
- **Second tab, "Child boards"** — an overview of the team tree's boards
  (read-only): a tree indented by path, per-status card counters (without
  `merged`), cards "in progress" with owner/role and update time, and a
  per-board read error on its own line; clicking a board opens its columns,
  clicking a card opens details (description, tokens, role/owner, `spec`).
  Refresh is polling every 3 s plus ⟳; empty states are distinct: no manifest
  (with a `bin/board-children.sh` hint), manifest not parsed, no boards. There
  is no drag&drop and no move buttons here: the parent looks, it does not manage.
- **Refresh:** polling every 3 seconds plus a ⟳ button; light and dark themes;
  board mockups live in `dsh-kanban/docs/` and are rendered from the real style
  table.

## 2. Board watcher (host half)

- **Watches boards:** `.kanban/tasks` of the main checkout and of task worktrees
  (`worktrees/*`, `.worktrees/*`). Copies of one card are merged by `updated`
  freshness (ties go to the worktree), only the same-named card is taken from a
  worktree, and a file whose front-matter `id` disagrees with its name is
  discarded.
- **Notices delivered into sessions** (through `sessionController.prompt` in
  queue mode, so a busy session does not lose them):
  - `in-review`/`testing`/`ready`/`blocked` → `in-progress` returns to the card
    owner;
  - a card in `in-review` goes to the reviewer, in `testing` to the verifier, in
    `ready` to the dispatcher;
  - **assignment**: a card in `todo` with an owner notifies that executor
    ("#N has been assigned to you, take it");
  - **shortfall**: fewer than `minTodo` cards in `todo` notifies the dispatcher
    ("replenish from backlog").
- **Delivery reliability:** deduplication by card version
  (`id:status:updated`) plus a state file; undelivered notices are remembered in
  `.watcher-pending.json` and retried on profile start; the startup pass
  announces whatever is already waiting for a role or an assignment.
- **Roles are discovered automatically** from the `agent-preset/selected`
  event and stored per board in `.kanban/.watcher-roles.json` (survives
  restarts); `roles` in the plugin row is a manual override. A role does not
  leak between boards: both capture and delivery check the session's working
  directory.
- **`boards` and `roots`:** explicit project roots or automatic tree discovery —
  every folder with `.kanban/tasks` gets its own watcher, role map and notices.
- **Client → host command channel** `kanbanCardActions` (a plugin-owned Typert
  remote): GUI `assign`/`unassign`, runs `bin/task-assign.sh` without a shell,
  validates requests, serializes assignments, verifies that the card actually
  changed, and cancels work when the plugin is unloaded.
- **Child boards overview** `kanbanChildren` (a read-only Typert remote):
  `read` with `{ request: { sessionId } }` reads `.kanban/children.json` from the
  session directory, snapshots every board (`.kanban/tasks` plus
  `worktrees/*`, cards merged by `updated` freshness like the watcher) and
  returns counters; a single board's failure lands in its `problems`/`missing`
  and does not fail the rest; limits are 200 boards and 2,000 cards, and there
  are no mutating arguments at all.
- **Channel self-check** after startup: "sees the endpoint" / "not verified —
  gateway not ready yet" / "not announced", with distinct log levels.
- **Graceful shutdown:** disposal via `ctx.effect` closes watchers and timers,
  aborts in-flight notices and child `task-assign.sh` processes, is idempotent
  and fits the DSH budget (5 s) — verified against a real Host process.

## 3. Team workflow (protocol)

- **Roles:** `dispatcher`, `worker`, `reviewer`, `verifier` — agent presets
  installed into the profile; permissions and transitions are described in
  `AGENTS.md`.
- **The card is the single source of status** (front matter: `status`, `owner`,
  `role`, `spec`, `since`, `tokens`, `tokens_<role>`, `note`, `branch`,
  `worktree`). Transitions go through `bin/task-move.sh` only; merging goes
  through `bin/task-commit.sh` only.
- **Per-task isolation:** `task-new.sh` creates `worktrees/<id>`, branch
  `task/<id>` and the card inside that branch. Merging is `--no-ff` with a
  `[<ID>] …` message, after which the worktree is removed. `git push` is a human
  action only.
- **Queue and backlog:** specs in `.kanban/specs/<NNN>.md` and the `spec` field;
  tasks are sliced into `backlog` without an owner; `minTodo` lives in
  `.kanban/board.json`; the executor pool is `.kanban/.workers.json`; issuing is
  done by `backlog-fill.sh` in FIFO order over the merged board snapshot
  (including cards that exist only in a branch); manual assignment is
  `task-assign.sh`.
- **Protocol limits:** one `in-progress` per agent, at most three tasks in
  flight, only the dispatcher issues tasks, and review/testing return the card
  to the same executor.

## 4. Tools (`bin/`, 19 scripts)

| Group | Scripts |
|---|---|
| Tasks | `task-new` (worktree + branch + card, `--backlog`, `--spec`), `task-move` (validated transitions), `task-commit` (merge and `--no-merge`), `task-assign` (assign/unassign), `backlog-fill`, `spec-new`, `task-usage` (tokens from the DSH projection cache) |
| Board | `board-status` (dump, `--json`), `board-sync` (manifest for worktrees outside the project), `board-children` (child boards manifest: `--root`, `--depth`, `--base`, `--board`, `--print`) |
| Installation | `install-kanban` (web/desktop profiles, guards against double mounting), `install-presets`, `gen-role-presets` (presets generated from the built-in `standard` preset) |
| Quality | `test.sh` (whole suite), `test-scripts.sh` (scripts, locales, exit codes), `host-shutdown-check.mjs` (real Host: control/board/roots/events), `render-mockup.sh`, `node.sh` |

## 5. Compatibility and reliability

- Verified on DSH **0.2.1-rc.3** (and 0.1.7 earlier) with macOS bash 3.2:
  presets are regenerated from the DSH template; scripts do not break under
  `LANG=C.UTF-8`; exit codes are not masked; `task-assign` and `backlog-fill`
  honestly return 1/2/3/4.
- DSH updates install cleanly (graceful shutdown); upgrades preserve the
  profile bundles, the plugin symlink, the role map and `.workers.json`.
- Deduplication and retries for undelivered notices; assignment results are
  verified on the channel side; child processes are cancelled on unload.

## 6. Tests, mockups, documentation

- **12 test files** plus `bin/test-scripts.sh`: **408 checks** in `bin/test.sh` —
  browserless rendering, card parser, worktree copy merging, notices, worktree
  observation, the command channel, dispose/shutdown, child boards overview
  (service and tab), scripts, locales. There is also a separate slow harness for
  a real Host process (not part of the suite).
- Mockups in `docs/` are rendered from the real `client.js` style table; checks
  keep the file table in `KANBAN.md` truthful and complete.
- Documentation: `KANBAN.md` (overview, installation, scenarios, limits,
  troubleshooting), `AGENTS.md` (agent protocol), `.kanban/tasks/README.md`
  (card format), specs `001`–`004` (backlog and issuance; human in the loop;
  graceful shutdown; child boards), and the `kanban` and `commit` skills.

## 7. Boundaries: what is not here

- The board does **not** write state into DSH storage: files are the source of
  truth, so updates are polled (every 3 s) rather than streamed.
- Humans move cards only between `backlog` and `todo`; drag between other
  columns, priorities, deadlines and mobile DnD are not supported.
- **Child boards are read-only:** the parent sees the tree summary and opens
  child boards without buttons or drag&drop; assignment and transitions belong
  to the child board's team. Read-only is a service and UI guarantee, not a
  sandbox: if child boards live inside the parent's workspace, the parent can
  physically write to them with bash; keep the dashboard workspace outside the
  child tree for hard isolation.
- The set is self-contained: there are no external copies, mirrors or
  synchronisation with other projects — this repository is the only source, and
  `bin/test.sh` is fully green.
- Pushing to a remote is not an agent operation.

## Numbers

48 tasks merged, ~4,300 lines of plugin code, ~5,100 lines of tests,
19 scripts, 408 checks in the suite (all green).

## Roadmap ideas (v2)

- state in DSH storage (`storageDomain`) and a Typert stream for live updates;
- a `kanban_move` tool for agents instead of file operations;
- a full-width board panel (the `main` slot) instead of a sidebar tab.
