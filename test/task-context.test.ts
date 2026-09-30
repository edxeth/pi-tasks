import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore, type Model, type Provider } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { afterEach, beforeEach, expect, it } from "vitest";
import initExtension from "../src/index.js";
import { getSessionTaskDirPath } from "../src/task-store.js";

// The real Anthropic serializer runs; only its external HTTP transport is faked.
// This captures extension effects that a faux provider or direct hook call misses.
const RequestSchema = Type.Object({
  system: Type.Optional(Type.Array(Type.Unknown())),
  messages: Type.Array(Type.Object({ role: Type.String(), content: Type.Unknown() })),
  tools: Type.Optional(Type.Array(Type.Unknown())),
});
type Request = Static<typeof RequestSchema>;

const model: Model<"anthropic-messages"> = {
  id: "context-test",
  name: "Context test",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://example.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 1024,
  compat: {
    supportsMidConvoSystemMessages: true,
    supportsMidConvoEffort: true,
    forceAdaptiveThinking: true,
  },
};

function assistantResponse(reply: "text" | "list"): Response {
  const events = [
    {
      type: "message_start",
      message: { id: "fixture-response", model: model.id, usage: { input_tokens: 1, output_tokens: 1 } },
    },
    {
      type: "content_block_start", index: 0,
      content_block: { type: "thinking", thinking: "Fixture reasoning.", signature: "fixture-signature" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start", index: 1,
      content_block: reply === "list"
        ? { type: "tool_use", id: "fixture-tool", name: "task_list", input: {} }
        : { type: "text", text: "Done." },
    },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: reply === "list" ? "tool_use" : "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let directory: string;
let sessions: AgentSession[];
let taskDirectories: string[];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pi-tasks-context-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  sessions = [];
  taskDirectories = [];
});

afterEach(() => {
  for (const session of sessions) session.dispose();
  for (const path of taskDirectories) rmSync(path, { recursive: true, force: true });
  rmSync(directory, { recursive: true, force: true });
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

async function createFixture(
  replies: Array<"text" | "list"> = [],
  sessionManager = SessionManager.create(directory, join(directory, "sessions")),
) {
  const requests: Request[] = [];
  let revision = "Original project instructions.";
  const probe: ExtensionFactory = (pi) => {
    pi.on("before_agent_start", (event) => {
      event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, fixture: revision };
    });
    pi.on("before_provider_request", (event) => {
      if (!Check(RequestSchema, event.payload)) throw new Error("Unexpected Anthropic request shape");
      requests.push(structuredClone(event.payload));
    });
  };
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  });
  const base = anthropicProvider();
  const provider: Provider<"anthropic-messages"> = {
    ...base,
    getModels: () => [model],
    streamSimple: (requestModel, context, options) => base.streamSimple(requestModel, context, {
      ...options, cacheRetention: "none", fetch: async () => assistantResponse(replies.shift() ?? "text"),
    }),
  };
  modelRuntime.registerNativeProvider(provider);
  await modelRuntime.setRuntimeApiKey("anthropic", "offline-test-key");
  async function openSession(sessionManager: SessionManager) {
    const resourceLoader = new DefaultResourceLoader({
      cwd: directory, agentDir: directory, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [initExtension, probe],
    });
    await resourceLoader.reload();
    expect(resourceLoader.getExtensions().errors).toEqual([]);
    taskDirectories.push(getSessionTaskDirPath(sessionManager.getSessionFile() ?? sessionManager.getSessionId()));
    const { session } = await createAgentSession({
      cwd: directory, agentDir: directory, model, modelRuntime, resourceLoader, settingsManager, sessionManager,
      thinkingLevel: "high", tools: ["task_list", "task_write"],
    });
    sessions.push(session);
    return session;
  }
  const session = await openSession(sessionManager);
  return {
    session, requests,
    updateInstructions: () => { revision = "Updated project instructions."; },
    resume: async () => {
      const file = sessionManager.getSessionFile();
      if (!file) throw new Error("Fixture session was not persisted");
      session.dispose();
      sessions.splice(sessions.indexOf(session), 1);
      return openSession(SessionManager.open(file));
    },
  };
}

it("preserves the historical request prefix when project instructions change", async () => {
  const { session, requests, updateInstructions } = await createFixture();
  await session.prompt("First request.");
  expect(session.getLastAssistantText()).toBe("Done.");
  updateInstructions();
  await session.prompt("Second request.");
  expect(session.getLastAssistantText()).toBe("Done.");
  expect(requests).toHaveLength(2);
  const [first, second] = requests;
  expect(second.system).toEqual(first.system);
  expect(second.tools).toEqual(first.tools);
  expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
  expect(second.messages).toContainEqual(expect.objectContaining({
    role: "system", content: expect.arrayContaining([expect.objectContaining({
      type: "text", text: expect.stringContaining("Updated project instructions."),
    })]),
  }));
  expect(second.messages).toContainEqual(expect.objectContaining({
    role: "assistant", content: expect.arrayContaining([
      { type: "thinking", thinking: "Fixture reasoning.", signature: "fixture-signature" },
    ]),
  }));
});

it("keeps policy and tool results across tool and idle continuations", async () => {
  const { session, requests } = await createFixture(["list", "text", "text"]);
  await session.prompt("List tasks.");
  expect(session.getLastAssistantText()).toBe("Done.");
  expect(requests).toHaveLength(2);
  expect(requests[1].messages).toContainEqual(expect.objectContaining({
    role: "user", content: expect.arrayContaining([expect.objectContaining({
      type: "tool_result", tool_use_id: "fixture-tool", is_error: false,
      content: "No tasks found",
    })]),
  }));
  await session.sendCustomMessage({ customType: "fixture", content: "Continue.", display: false }, { triggerTurn: true });
  expect(session.getLastAssistantText()).toBe("Done.");
  expect(requests).toHaveLength(3);
  for (const request of requests) {
    expect(request.system).toEqual(requests[0].system);
    const policies = request.messages.filter((message) => JSON.stringify(message.content).includes("Task workflow guidance:"));
    expect(policies).toHaveLength(1);
    expect(policies[0]).toEqual(requests[0].messages[0]);
    // The persisted empty-list reminder must not vanish on the next request.
    expect(JSON.stringify(request.messages)).toContain("The task list is empty");
  }
});

it("preserves signed history when a resumed session loads updated instructions", async () => {
  const { session, requests, updateInstructions, resume } = await createFixture();
  await session.prompt("First request.");
  expect(session.getLastAssistantText()).toBe("Done.");
  updateInstructions();
  const resumed = await resume();
  await resumed.prompt("Continue after restart.");
  expect(resumed.getLastAssistantText()).toBe("Done.");
  expect(requests).toHaveLength(2);
  const [first, second] = requests;
  expect(second.system).toEqual(first.system);
  expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages);
  const assistantIndex = second.messages.findIndex((message) => message.role === "assistant");
  const updateIndex = second.messages.findIndex((message) => message.role === "system" &&
    JSON.stringify(message.content).includes("Updated project instructions."));
  expect(assistantIndex).toBeGreaterThanOrEqual(0);
  expect(updateIndex).toBeGreaterThan(assistantIndex);
  expect(second.messages[assistantIndex].content).toContainEqual({
    type: "thinking", thinking: "Fixture reasoning.", signature: "fixture-signature",
  });
});

it("keeps the prompt and tools when a skill was saved before the initial system message", async () => {
  // The reported session has this ordering: an injected skill precedes its first prompt.
  const manager = SessionManager.create(directory, join(directory, "sessions"));
  manager.appendCustomMessageEntry("fixture-skill", "Skill instructions.", false);
  const { session, requests, updateInstructions } = await createFixture([], manager);
  await session.prompt("First request.");
  expect(session.getLastAssistantText()).toBe("Done.");
  expect(requests).toHaveLength(1);
  expect(JSON.stringify(requests[0].system)).toContain("Original project instructions.");
  expect(requests[0].tools).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "task_list" }), expect.objectContaining({ name: "task_write" }),
  ]));
  expect(JSON.stringify(requests[0].messages)).toContain("Skill instructions.");
  updateInstructions();
  await session.prompt("Second request.");
  expect(requests).toHaveLength(2);
  expect(requests[1].system).toEqual(requests[0].system);
  expect(requests[1].messages.slice(0, requests[0].messages.length)).toEqual(requests[0].messages);
});
