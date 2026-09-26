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
- When placing injected or generated guidance: the policy is the only request-stage message — byte-stable, anchored after any leading system messages so every request extends the previous cache prefix (some pi runtimes ≤0.86.x expose the system head to `context` handlers and providers read prompt and initial tools from `messages[0]`; older type contracts omit `"system"` from the context role union, so widen the role comparison). Reminders persist as transcript messages via the before_agent_start result `message` and replay on every later request. Never deliver a message that appears on one request and vanishes on the next: it costs a cache re-write and the transcript never sees it.
