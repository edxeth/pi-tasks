# pi-tasks

`pi-tasks` gives [pi](https://github.com/badlogic/pi-mono) a real task system.

It started from `tintinweb/pi-tasks`, took heavy inspiration from Claude Code's task model, and was reworked by [`me`](https://github.com/edxeth) to push toward Claude Code parity where pi can support it cleanly.

Five tools. One widget. File-backed state. Atomic writes. Session-aware restore.

This is not Jira in a terminal. It is not a sticky-note toy. It is the discipline layer pi needs once a session stops being trivial!

## Why this exists

pi is a minimal coding harness. Good. Keep it that way.

But long sessions rot unless task state is explicit. Models drift. Plans get rewritten in circles. Done work comes back from the dead. `pi-tasks` fixes that without dragging in a whole second runtime.

Small surface area. Sharp behavior. Clear state.

https://github.com/user-attachments/assets/f0229862-417b-4ef2-9486-2b8736b7ce87

## What you get

- 5 model-callable tools: `task_create`, `task_list`, `task_get`, `task_update`, `task_batch`
- 2 interactive commands: `/tasks` and `/tasks-clear-completed`
- `Ctrl+Alt+T` to cycle the widget through Open, All, and Hidden
- per-session durable storage under `~/.pi/tasks/`
- branch-aware restore when you move around the session tree
- fork-copy behavior when you fork a session
- hidden read-only reminders after 10 turns without task-tool use
- per-task stats for runtime, tool usage, last tool, and output tokens
- output token accounting also includes subagent results, including [`pi-subagents`](https://github.com/edxeth/pi-subagents)
- atomic batch updates with file locking
- no recycled task IDs

## Install

```bash
pi install git:github.com/edxeth/pi-tasks
```

## The surface

### Tools

- `task_create` — create one structured task
- `task_list` — list the session task list
- `task_get` — inspect one task in detail
- `task_update` — update status, text, metadata, and dependencies
- `task_batch` — apply multiple create/update/delete operations atomically

### UI

- `/tasks` opens or switches the task widget view
- `/tasks-clear-completed` deletes completed tasks after confirmation
- `Ctrl+Alt+T` cycles widget mode: Open → All → Hidden

The widget is for interactive sessions. The tools work in any mode.

### Troubleshooting widget order

Pi renders above-editor extension widgets in registration order. `pi-tasks` keeps its initial widget slot stable after startup, but if another above-editor widget appears in the wrong place, check extension load order in `~/.pi/agent/settings.json`.

For example, to render an agent widget above tasks and a status/powerline widget below tasks, load them in that order in the `packages` list.

## How it behaves

This extension is session-scoped by design. One session gets one task store. That is the point.

When you fork a session, the child gets a copy of the parent task state. When you jump around the session tree, task state restores with the branch. That means tasks follow the actual conversation history instead of becoming vague global sludge.

Open work is kept separate from completed work. Blockers are tracked bidirectionally. Warnings are surfaced for cycles, self-dependencies, and dangling references. Completed tasks stay on disk until you delete them or clear them.

After 10 turns of not using the task tools, `pi-tasks` injects a hidden reminder into context. It is read-only. It lists open tasks only. It does not spam the visible transcript.

Task stats are stored in `metadata.stats` and updated from real execution: start time, completion time, tool count, last tool, and output tokens. That token accounting also includes subagent output from [`pi-subagents`](https://github.com/edxeth/pi-subagents), so child-agent output is counted back into the parent task.

`task_batch` is all-or-nothing. If one operation fails, none of it commits. No half-written garbage.

## Storage

Tasks live here:

```text
~/.pi/tasks/<sessionKey>/
  .lock
  .highwatermark
  1.json
  2.json
  ...
  .tree/<leafId>/
```

Notes:

- ids are monotonic and never reused
- writes use temp-file replace semantics
- concurrent access is lock-protected
- widget view state is persisted separately in pi settings

## Credit

Credit where it is due: this started as a fork of `tintinweb/pi-tasks`.

What is here now was heavily reworked for pi, tightened up, pared down, and pushed toward a cleaner task model.

## License

MIT. See [LICENSE](./LICENSE).
