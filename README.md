# pi-tasks

## 🌐 **Join the Community**

> [!NOTE]
> **Building with AI doesn’t have to be a solo grind.**  
> Join our Discord community to meet other people exploring the latest models, tools, workflows, and ideas: **https://discord.gg/whhrDtCrSS**
>
> We talk about what’s new, what’s useful, and what’s actually worth paying attention to in AI.  
> *And if you want more than conversation,* members also get access to **heavily discounted AI products and services** — including deals on tools like **ChatGPT Plus** and more for just a few dollars.

`pi-tasks` gives [pi](https://github.com/badlogic/pi-mono) a real task system.

It started from `tintinweb/pi-tasks`, took heavy inspiration from Claude Code's task model, and was reworked by [`me`](https://github.com/edxeth) to push toward Claude Code parity where pi can support it cleanly.

Two tools. One widget. File-backed state. Atomic writes. Session-aware restore.

This is not Jira in a terminal. It is not a sticky-note toy. It is the discipline layer pi needs once a session stops being trivial!

## Why this exists

pi is a minimal coding harness. Good. Keep it that way.

But long sessions rot unless task state is explicit. Models drift. Plans get rewritten in circles. Done work comes back from the dead. `pi-tasks` fixes that without dragging in a whole second runtime.

Small surface area. Sharp behavior. Clear state.

https://github.com/user-attachments/assets/f0229862-417b-4ef2-9486-2b8736b7ce87

## What you get

- 2 model-callable tools: `task_write` and `task_list`
- 2 interactive commands: `/tasks` and `/tasks-clean`
- `Ctrl+Alt+T` to cycle the widget through Open, All, and Hidden
- per-session durable storage under `~/.pi/tasks/`
- branch-aware restore when you move around the session tree
- fork-copy behavior when you fork a session
- hidden read-only reminders after 10 turns without task-tool use
- per-task stats for agent-active runtime, tool usage, last tool, and output tokens
- output token accounting also includes subagent results, including [`pi-subagents`](https://github.com/edxeth/pi-subagents)
- atomic `task_write` updates with file locking
- no recycled task IDs

## Install

Requires Pi (`@earendil-works/pi-coding-agent`) 0.87.1 or newer.

```bash
pi install git:github.com/edxeth/pi-tasks
```

## The surface

### Tools

- `task_write` — apply an atomic operations array for creates, updates, and deletes; single-operation calls auto-wrap, and validation errors show the expected shape
- `task_list` — show the session task overview, or pass `taskId` to inspect one task in detail

### UI

- `/tasks` opens or switches the task widget view (`on`, `open`, `all`, `hide`, `cycle`, `off`)
- `/tasks-clean` deletes completed tasks after confirmation and leaves an expandable, themed checklist in the transcript without adding model-context tokens.
- `Ctrl+Alt+T` cycles widget mode: Open → All → Hidden

The widget is for interactive sessions. The tools work in any mode.

### tasksMode

The `tasksMode` key in `~/.pi/agent/settings.json` controls the extension:

- `open` (default) / `all` — tools active, widget shown in that view
- `hidden` — tools active, widget hidden
- `off` — nothing registers: no tools, no system-prompt guidance, no reminders, no widget. Zero context cost. Only `/tasks` stays available so `/tasks on` can re-enable everything (takes effect in new sessions). Use `/tasks off` to turn it off from a running session.

### Troubleshooting widget order

Pi renders above-editor extension widgets in registration order. `pi-tasks` keeps its initial widget slot stable after startup, but if another above-editor widget appears in the wrong place, check extension load order in `~/.pi/agent/settings.json`.

For example, to render an agent widget above tasks and a status/powerline widget below tasks, load them in that order in the `packages` list.

## How it behaves

This extension is session-scoped by design. One session gets one task store. That is the point.

When you fork a session, the child gets a copy of the parent task state. When you jump around the session tree, task state restores with the branch. That means tasks follow the actual conversation history instead of becoming vague global sludge.

Open work is kept separate from completed work. Blockers are tracked bidirectionally. Warnings are surfaced for cycles, self-dependencies, and dangling references. Completed tasks stay on disk until you delete them or clear them.

After 10 turns of not using the task tools, `pi-tasks` injects a hidden reminder into context. It is read-only. It lists open tasks only. It does not spam the visible transcript.

The task policy is included on every model request without merging later system instructions into the original prompt. Persisted reminders remain in subsequent requests. This preserves historical prefixes for models that support system updates within a conversation; it cannot prevent another extension or a provider from rewriting them.

Task stats are stored in `metadata.stats` and updated from real execution: start time, completion time, agent-active runtime, tool count, last tool, and output tokens. That token accounting also includes subagent output from [`pi-subagents`](https://github.com/edxeth/pi-subagents), so child-agent output is counted back into the parent task.

Task runtime counts only agent-active time: the spans between each `agent_start` and `agent_end`, which cover LLM streaming, tool runs, and subagent tool calls inside an agent loop run. Gaps between runs — reading or composing a prompt, auto-compaction, retry backoff, and other parent-idle or background-only periods — do not tick the timer. Every task that is `in_progress` during a span accrues that full span concurrently; a task entering `in_progress` mid-run starts at that point, and completing, pausing, or deleting a task stops only that task while other in-progress tasks keep accruing. Portions of a run with no task in progress are not attributed. Tool and output-token telemetry remains single-owner, attributed to the selected in-progress task rather than duplicated across overlapping tasks. If pi stops hard mid-run, the unclosed span is dropped on the next session start, so a crash can undercount but never inflate. In-progress tasks recorded before this behavior existed switch to active-time tracking at their next session start; their timer stops growing until an agent actually runs on them. Previously completed tasks retain their recorded runtimes, including legacy wall-clock durations.

`task_write` is all-or-nothing. If one operation fails, none of it commits. No half-written garbage.

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
