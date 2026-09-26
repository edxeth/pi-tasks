# AGENTS.md

pi extension: task tools + live TUI widget. TypeScript, vitest. Runs from `src/index.ts` (package.json `pi.extensions`); `dist/` is a gitignored publish artifact, so no build step is needed to test local changes.

## Commands

| Command | What it does |
| --- | --- |
| `npx vitest run` | Full test suite. Run before handoff. |
| `npx tsc --noEmit` | Typecheck. Run with the tests. |

- When using a pi extension event: check it exists in this repo's `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` — the pinned copy is the compile-time contract, while the installed pi decides what fires at runtime, and the two can drift.
- When adding always-on model guidance: never return `systemPrompt` from `before_agent_start`. Pi applies it as a forced head AFTER the `context` phase, which discards every other extension's head edits on those turns and alternates head shapes between forced and unforced turns. Deliver guidance as a `context`-phase message (see the policy injection in `src/index.ts`).
- When verifying prompt-delivery or request-shape claims: unit tests and the faux provider cannot see them — `context` and `before_provider_request` effects need a live `pi -p` run with a probe extension logging at `before_provider_request`. Head-edit probes must modify the system message's `sections`; `content` edits are dropped on the wire.
- When moving injected guidance messages: keep transient messages (nudges, reminders) at the request tail and stable ones (the policy) at the front. A transient message at the front invalidates the cached prefix for the whole conversation on every later request; at the tail it costs one turn's re-write per firing.
