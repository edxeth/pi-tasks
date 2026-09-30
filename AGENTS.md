# AGENTS.md

pi extension: task tools + live TUI widget. TypeScript, vitest. Runs from `src/index.ts` (package.json `pi.extensions`); `dist/` is a gitignored publish artifact, so no build step is needed to test local changes.

## Commands

| Command | What it does |
| --- | --- |
| `npx vitest run` | Full test suite. Run before handoff. |
| `npx tsc --noEmit` | Typecheck. Run with the tests. |

- When using a pi extension event: check it exists in this repo's `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` — the pinned copy is the compile-time contract, while the installed pi decides what fires at runtime, and the two can drift.
- When adding always-on model guidance: use `context_with_system`, preserving system updates in place (see `src/index.ts`). Returning changed messages from `context` makes Pi merge later system updates into the historical head, invalidating signed thinking. Returning `systemPrompt` from `before_agent_start` also replaces that head and overrides other extensions' edits. Keep `context` observers read-only.
- When verifying prompt delivery: use the real SDK and provider serializer with a fake HTTP boundary (`test/task-context.test.ts`), not just direct hook calls or a faux provider. Include a later system update and resume, not only unchanged prompts. Verify server-side thinking replay separately with live `pi -p`, a request probe, and response diagnostics; keep required auth adapters when isolating that run. Head-edit probes must change `sections`, not `content`.
- When placing injected guidance: keep the policy byte-stable after the leading system messages. An early skill entry may precede the initial system declaration; move only that declaration to the head, never merge later updates. Reminders persist via the `before_agent_start` result `message` and replay on later requests. Never inject a message that vanishes on the next request. Reminders fire only at prompt boundaries, so a reminder due during tool or idle continuations deliberately waits for the next user prompt.
