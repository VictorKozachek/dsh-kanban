# Onboarding: from install to the first assignment

A step-by-step path for a new user: install the plugin, connect **your own**
project, build a four-role team and move the first card across the board.
The steps were verified on a clean DSH profile and on a separate test project.

> In short: the plugin is the board and the watcher. The task protocol
> (`AGENTS.md`, `bin/task-*`, `.kanban/`) lives in **your project**: the agent
> reads it from its working directory.

![How the board works: a card moves from backlog to merge](dsh-kanban/docs/onboarding-demo.gif)

## Requirements

- DeepSeek Harness **0.2.1-rc.3+** (desktop app or `dsh web`);
- `git` — tasks are created in git worktrees;
- `node` — the scripts (`bin/node.sh` finds Node automatically);
- `python3` — used by install and test scripts;
- a project that is a git repository with at least one commit.

## Step 1. Install the plugin

```bash
git clone https://github.com/VictorKozachek/dsh-kanban.git
cd dsh-kanban

bin/install-kanban.sh desktop    # Electron desktop app
# or
bin/install-kanban.sh            # "web" profile (dsh web)
```

Restart DSH: profiles read their bundle list on startup.

Check: open a conversation, click **+** in the right tab strip and add
**Kanban**. Role presets need no separate install — they are registered every
time the plugin starts.

## Step 2. Connect your project

By default the plugin watches `$HOME/projects/dsh-kanban` — that is an example.
Point it at your project in the **profile** patch `~/.dsh/cordis.patch.yml`
(not the file inside the clone: that one is tracked by git and updates with the
plugin):

```yaml
- id: ui-kanban
  config:
    boards:
      - /Users/you/projects/my-project      # your project
    roots: []                                # trees with component boards
    # ignore:                                # copies/experiments to skip
    #   - /Users/you/projects/**/tmp
```

`boards` are projects whose `.kanban/tasks` is served; `roots` are trees where
the watcher discovers component boards by itself. Note: the override replaces
`config` entirely, so list everything you need.

Restart DSH. Check:

```bash
cat /tmp/dsh-kanban-watch.diag.json
```

`applied.boards` must include your project (or its components), `fatal` must be
`null`. If the project is missing, check the path and the restart.

## Step 3. Put the protocol into the project

One command scaffolds everything the agents and scripts need:

```bash
~/dsh-kanban/bin/kanban-init.sh ~/projects/my-project
```

It copies `bin/` (tasks, board, doctor), `AGENTS.md`, the card format,
`.kanban/board.json`, the `.gitignore` block and
`dsh-kanban/lib/watcher-core.js` (used by `board-status`). Existing files are not
overwritten; `--print` shows the plan, `--force` overwrites.

Check:

```bash
cd ~/projects/my-project
bin/doctor.sh                # what is installed and what is missing
bin/board-status.sh          # an empty board is fine
git add -A && git commit -m "kanban: task protocol"
```

> `bin/task-*` work relative to the project root, so run them from the project
> (for a worktree task, run them from `worktrees/<id>` — its card lives there).

## Step 4. Build the team

1. Add a **workspace** in the sidebar — your project root.
2. Create a **`dispatcher`** session (orchestrator): New Session → preset
   `dispatcher`.
3. In the same workspace create three more: **`worker`**, **`reviewer`**,
   **`verifier`**. Optional: **`analyst`** (business analyst) — interviews business,
   maps processes and prepares specs; it receives no board notices.
4. Open the **Kanban** tab (right sidebar → **+** → Kanban).

The watcher binds roles automatically from preset selection and stores the map
in `.kanban/.watcher-roles.json`. With **several executors**, list their sessions
in `.kanban/.workers.json` (order = assignment priority):

```json
["session-…", "session-…"]
```

## Step 5. The first card

From the project root:

```bash
bin/task-new.sh "Fix the QR export"
```

This creates `worktrees/001`, branch `task/001` and the card inside that branch;
the board shows it in `todo` immediately.

Assignment — either:

- drag the card `backlog → todo` in the GUI (it picks a free executor), or
- manually:

```bash
bin/task-move.sh 001 todo --owner <executor-session-id>
```

The watcher then sends the executor an assignment. The cycle:

| Step | Who | Command |
|---|---|---|
| Started | worker | `bin/task-move.sh 001 in-progress --owner "$DSH_SESSION_ID" --role worker` |
| Ready for review | worker | `bin/task-move.sh 001 in-review --note "what was done; how to verify"` |
| Accepted | reviewer | `bin/task-move.sh 001 testing` |
| Verified | verifier | `bin/task-move.sh 001 ready` |
| Merge | orchestrator | `bin/task-commit.sh 001` (from the main checkout) |

All transitions and rules are in `AGENTS.md` and `.kanban/tasks/README.md`.

## Step 6. Verify the watcher

- `/tmp/dsh-kanban-watch.diag.json` (`DSH_KANBAN_DIAG_PATH` overrides it):
  - `applies[]` — config, board/watcher counts, errors;
  - `events[]` — `announce`, `deliver-once`, `delivered`, failure reasons;
  - `heartbeatAt` — the plugin is alive (updates every 20 s).
- `.kanban/.watcher-pending.json` — undelivered assignments; cleaned on startup
  from dead sessions and invalid owners.
- `bin/board-status.sh` — what the board sees.

## Common problems

| Symptom | Cause and fix |
|---|---|
| No Kanban tab | plugin not installed/restarted: `bin/install-kanban.sh desktop`, restart |
| Board is empty | no `.kanban/tasks` in the session's working directory, or cards are not `*.md` |
| No assignment | the role session has no preset (`.watcher-roles.json` empty); `owner` is not a session id; board is not in `boards`/`roots` |
| Session became `standard` | presets were not registered: update the plugin and restart; the preset id in the session log is preserved |
| Role is a subagent session | prompt is impossible: recreate the role as a normal root session with the preset |
| `git worktree add` failed | not a git repository, or no commit yet |
| `bin/node.sh` says "need node" | set `DSH_NODE=/path/to/node` |
| `bin/board-status.sh` fails to import | copy `dsh-kanban/lib/watcher-core.js` (step 3) |
| Duplicate cards / noisy diagnostics | `tmp/` clones got scanned: add `ignore` to the profile (step 2) |

## What next

- **Backlog and specs**: `bin/spec-new.sh "Title"` →
  `bin/task-new.sh "..." --backlog --spec NNN`; assignment via
  `bin/backlog-fill.sh` when `todo` is below `minTodo` (`.kanban/board.json`).
- **Several executors**: `.kanban/.workers.json` (order = priority).
- **Merge**: only `bin/task-commit.sh` from the main checkout; pushing is a human
  step.
- **Diagnostics and details**: `KANBAN.md`, section "Диагностика сторожа".

## Current limitations

- The protocol (`bin/`, `AGENTS.md`, `.kanban/`) is copied into the project by
  hand; after a plugin update, copy the scripts again. An automatic
  `bin/kanban-init` is planned.
- `bin/board-status.sh` needs `dsh-kanban/lib/watcher-core.js` from step 3.
- Role presets can only be chosen for a new session: an existing session keeps
  the preset recorded in its log.
