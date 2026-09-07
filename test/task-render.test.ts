import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getKeybindings, setKeybindings, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { ToolExecutionComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { initTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import initExtension from "../src/index.js";
import { getSessionTaskDirPath } from "../src/task-store.js";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let testAgentDir: string;
const storePaths: string[] = [];

beforeEach(() => {
  testAgentDir = mkdtempSync(join(tmpdir(), "pi-tasks-render-"));
  process.env.PI_CODING_AGENT_DIR = testAgentDir;
});

afterEach(() => {
  for (const path of storePaths.splice(0)) rmSync(path, { recursive: true, force: true });
  rmSync(testAgentDir, { recursive: true, force: true });
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

function mockCtx(sessionId: string) {
  return {
    hasUI: false,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => undefined,
      getLeafId: () => null,
      getBranch: (): ReturnType<SessionManager['getBranch']> => [],
    },
    ui: {
      notify() {},
      setStatus() {},
      setWidget() {},
      theme: {
        fg(_color: string, text: string) { return text; },
        bold(text: string) { return text; },
        strikethrough(text: string) { return text; },
      },
    },
  };
}

function mockPi() {
  const tools = new Map<string, any>();
  const lifecycleHandlers = new Map<string, ((...args: any[]) => any)[]>();
  const pi = {
    registerTool(def: any) { tools.set(def.name, def); },
    registerEntryRenderer() {},
    registerCommand() {},
    registerShortcut() {},
    on(event: string, handler: any) {
      if (!lifecycleHandlers.has(event)) lifecycleHandlers.set(event, []);
      lifecycleHandlers.get(event)?.push(handler);
    },
    sendMessage() {},
    events: { on() { return () => {}; }, emit() {} },
  };
  return {
    pi,
    tools,
    async fireLifecycle(event: string, ...args: any[]) {
      for (const handler of lifecycleHandlers.get(event) ?? []) await handler(...args);
    },
    async execute(name: string, params: any, ctx: any) {
      const tool = tools.get(name);
      if (!tool) throw new Error('Missing tool ' + name);
      await this.fireLifecycle('tool_execution_start', {}, ctx);
      const result = await tool.execute('call-1', params, undefined, undefined, ctx);
      await this.fireLifecycle('tool_result', { toolName: name, content: result.content, details: result.details, isError: false });
      return result;
    },
  };
}

const identityTheme = {
  fg(_color: string, text: string) { return text; },
  bold(text: string) { return text; },
  strikethrough(text: string) { return text; },
};

const ansiTheme = {
  fg(color: string, text: string) {
    const codes: Record<string, number> = { success: 32, error: 31, warning: 33, accent: 36, muted: 90, dim: 2, toolTitle: 35, text: 39, toolOutput: 37 };
    return '\x1b[' + (codes[color] ?? 39) + 'm' + text + '\x1b[0m';
  },
  bold(text: string) { return '\x1b[1m' + text + '\x1b[0m'; },
  strikethrough(text: string) { return '\x1b[9m' + text + '\x1b[0m'; },
};

function renderContext(args: unknown, extra?: { isPartial?: boolean; expanded?: boolean; isError?: boolean; lastComponent?: any; toolCallId?: string }) {
  return {
    args,
    toolCallId: extra?.toolCallId ?? 'call-1',
    invalidate() {},
    lastComponent: extra?.lastComponent,
    state: {},
    cwd: '/tmp',
    executionStarted: true,
    argsComplete: !extra?.isPartial,
    isPartial: extra?.isPartial ?? false,
    expanded: extra?.expanded ?? false,
    showImages: false,
    isError: extra?.isError ?? false,
  };
}

function renderCall(tool: any, args: unknown, width = 80, theme: any = identityTheme, extra?: Parameters<typeof renderContext>[1]) {
  return tool.renderCall(args, theme, renderContext(args, extra)).render(width);
}

function renderResult(tool: any, result: any, args: unknown, options?: { width?: number; theme?: any; expanded?: boolean; isPartial?: boolean; isError?: boolean; toolCallId?: string }) {
  const width = options?.width ?? 80;
  const theme = options?.theme ?? identityTheme;
  return tool.renderResult(result, { expanded: !!options?.expanded, isPartial: !!options?.isPartial }, theme, renderContext(args, options)).render(width);
}

function plain(lines: string[]): string[] {
  return lines.map((line) => stripTerminalSequences(line));
}

function appendTaskRecord(history: SessionManager, toolName: string, id: string, args: Record<string, unknown>, text: string, details?: unknown, isError = false) {
  history.appendMessage({
    role: 'assistant', content: [{ type: 'toolCall', id, name: toolName, arguments: args }],
    api: 'anthropic-messages', provider: 'anthropic', model: 'test', stopReason: 'toolUse', timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const result = { role: 'toolResult' as const, toolCallId: id, toolName, content: [{ type: 'text' as const, text }], details, isError, timestamp: 0 };
  history.appendMessage(result);
  return result;
}

describe('task tool rendering', () => {
  async function setup(label: string) {
    const sessionId = label + '-' + Date.now() + '-' + Math.random().toString(16).slice(2);
    const storePath = getSessionTaskDirPath(sessionId);
    storePaths.push(storePath);
    const mock = mockPi();
    const ctx = mockCtx(sessionId);
    initExtension(mock.pi as any);
    await mock.fireLifecycle('before_agent_start', {}, ctx);
    return { mock, ctx, storePath, write: mock.tools.get('task_write'), list: mock.tools.get('task_list') };
  }

  it('registers compact checklist renderers on both tools', async () => {
    const { write, list } = await setup('render-register');
    expect(typeof write.renderCall).toBe('function');
    expect(typeof write.renderResult).toBe('function');
    expect(typeof list.renderCall).toBe('function');
    expect(typeof list.renderResult).toBe('function');
  });

  it('restores update titles from preceding session records, not later renames or another branch', async () => {
    const { mock, ctx, write } = await setup('render-title-history');
    const history = SessionManager.inMemory('/tmp');
    const append = (id: string, args: Record<string, unknown>, text: string, isError = false) => {
      return appendTaskRecord(history, 'task_write', id, args, text, undefined, isError);
    };
    append('create', { operations: [{ action: 'create', subject: 'Verify headers and completed-task clearing', description: 'Desc' }] },
      'Operation 1: Task #6 created successfully: Verify headers and completed-task clearing');
    const completeArgs = { operations: [{ action: 'update', taskId: '6', status: 'completed' }] };
    const complete = append('complete', completeArgs, 'Operation 1: Updated task #6 status');
    const originalBranch = history.getBranch();
    append('rename', { operations: [{ action: 'update', taskId: '6', subject: 'Later title' }] }, 'Operation 1: Updated task #6 subject');
    append('failed-rename', { operations: [{ action: 'update', taskId: '6', subject: 'Uncommitted title' }] }, 'task_write failed: No changes were committed.', true);
    const updateArgs = { operations: [{ action: 'update', taskId: '6', description: 'New details' }] };
    const update = append('update', updateArgs, 'Operation 1: Updated task #6 description');
    ctx.sessionManager.getBranch = () => history.getBranch();
    await mock.fireLifecycle('session_start', { reason: 'resume' }, ctx);
    expect(plain(renderResult(write, complete, completeArgs, { toolCallId: 'complete' })).join('\n'))
      .toContain('✓ #6 Verify headers and completed-task clearing');
    expect(plain(renderResult(write, update, updateArgs, { toolCallId: 'update' })).join('\n'))
      .toContain('#6 Later title');
    expect(JSON.stringify(complete)).not.toContain('Verify headers');

    ctx.sessionManager.getBranch = () => originalBranch;
    await mock.fireLifecycle('session_tree', {}, ctx);
    expect(plain(renderResult(write, complete, completeArgs, { toolCallId: 'complete' })).join('\n'))
      .toContain('✓ #6 Verify headers and completed-task clearing');
    // The abandoned branch's cached title must not be reused.
    expect(plain(renderResult(write, update, updateArgs, { toolCallId: 'update' })).join('\n'))
      .not.toContain('Later title');

    ctx.sessionManager.getBranch = () => [];
    await mock.fireLifecycle('session_start', { reason: 'new' }, ctx);
    expect(plain(renderResult(write, complete, completeArgs, { toolCallId: 'complete' })).join('\n'))
      .toBe('  ✓ #6 Completed');
  });

  it('recovers names from earlier list/detail reads and modern snapshots', async () => {
    const { mock, ctx, write } = await setup('render-read-title-history');
    const history = SessionManager.inMemory('/tmp');
    appendTaskRecord(history, 'task_list', 'list', {}, '#3 [pending] Title from list');
    appendTaskRecord(history, 'task_list', 'detail', { taskId: '9' }, 'Task #9: Title from detail\nstatus: pending');
    const args = { operations: [{ action: 'update', taskId: '3', status: 'completed' }, { action: 'update', taskId: '9', status: 'completed' }] };
    const earlier = appendTaskRecord(history, 'task_write', 'earlier', args, 'Operation 1: Updated task #3 status\nOperation 2: Updated task #9 status');
    appendTaskRecord(history, 'task_write', 'snapshot', {}, 'Updated #3: subject', {
      kind: 'task_write', committed: true, rows: [{ id: '3', subject: 'Snapshot title', status: 'pending' }], warnings: [], opCount: 1,
    });
    appendTaskRecord(history, 'task_write', 'rejected', { action: 'update', taskId: '3', subject: 'Rejected title' }, 'Operation 1: Updated task #3 subject', { taskWriteFailed: true });
    const later = appendTaskRecord(history, 'task_write', 'later', args, 'Operation 1: Updated task #3 status\nOperation 2: Updated task #9 status');
    ctx.sessionManager.getBranch = () => history.getBranch();
    await mock.fireLifecycle('session_start', { reason: 'resume' }, ctx);
    const before = plain(renderResult(write, earlier, args, { toolCallId: 'earlier' })).join('\n');
    expect(before).toContain('✓ #3 Title from list');
    expect(before).toContain('✓ #9 Title from detail');
    const after = plain(renderResult(write, later, args, { toolCallId: 'later' })).join('\n');
    expect(after).toContain('✓ #3 Snapshot title');
    expect(after).toContain('✓ #9 Title from detail');
  });

  it.each(['empty-list', 'legacy-delete', 'snapshot-delete', 'cleanup'])('does not carry names across %s', async (removal) => {
    const { mock, ctx, write } = await setup('render-deleted-title-history');
    const history = SessionManager.inMemory('/tmp');
    appendTaskRecord(history, 'task_list', 'list', {}, '#3 [pending] Old task');
    const rows = [{ id: '3', subject: 'Old task', status: 'deleted' }];
    if (removal === 'empty-list') appendTaskRecord(history, 'task_list', 'empty', {}, 'No tasks found');
    if (removal === 'legacy-delete') appendTaskRecord(history, 'task_write', 'delete', { action: 'delete', taskId: '3' }, 'Operation 1: Updated task #3 deleted');
    if (removal === 'snapshot-delete') appendTaskRecord(history, 'task_write', 'delete', {}, 'Deleted #3', { kind: 'task_write', rows });
    if (removal === 'cleanup') history.appendCustomEntry('tasks-cleaned', { rows });
    const args = { operations: [{ action: 'update', taskId: '3', status: 'completed' }] };
    const result = appendTaskRecord(history, 'task_write', 'new-update', args, 'Operation 1: Updated task #3 status');
    ctx.sessionManager.getBranch = () => history.getBranch();
    await mock.fireLifecycle('session_start', { reason: 'resume' }, ctx);
    expect(plain(renderResult(write, result, args, { toolCallId: 'new-update' }))).toEqual(['  ✓ #3 Completed']);
  });

  it('replays the reported historical results as checklists without reexecuting their calls', async () => {
    const { mock, ctx } = await setup('render-reported-history');
    const fixtures = JSON.parse(readFileSync(new URL('./fixtures/legacy-task-results.json', import.meta.url), 'utf8'));
    const history = SessionManager.inMemory('/tmp');
    for (const [index, fixture] of fixtures.entries()) {
      appendTaskRecord(history, fixture.toolName, `restored-${index}`, fixture.args, fixture.result.content[0].text);
    }
    ctx.sessionManager.getBranch = () => history.getBranch();
    await mock.fireLifecycle('session_start', { reason: 'resume' }, ctx);
    const expected = [
      ['◉ #1 Inspect task rendering and reference extensions', '○ #2 Implement compact task call and result rendering', '○ #3 Verify task rendering and final diff'],
      ['◉ #4 Inspect task headers and completed-task clearing UI', '○ #6 Verify headers and completed-task clearing'],
      ['✓ #6 Verify headers and completed-task clearing'],
      ['✓ #1 Inspect task rendering and reference extensions', '✓ #6 Verify headers and completed-task clearing'],
    ];
    for (const [index, fixture] of fixtures.entries()) {
      const original = JSON.stringify(fixture);
      const tool = mock.tools.get(fixture.toolName);
      for (const name of ['dark', 'light']) {
        initTheme(name, false);
        const row = new ToolExecutionComponent(fixture.toolName, `restored-${index}`, fixture.args, {}, tool,
          { requestRender() {} } as any, '/tmp');
        row.setArgsComplete();
        row.updateResult(fixture.result);
        const collapsed = plain(row.render(140)).join('\n');
        for (const line of expected[index]) expect(collapsed).toContain(line);
        expect(collapsed).not.toMatch(/Operation \d|created successfully|\[completed\]|\d tools|tokens/);
        expect(collapsed).not.toMatch(/expand/i);
        row.setExpanded(true);
        const expanded = plain(row.render(160)).join('\n');
        if (fixture.toolName === 'task_list') {
          expect(expanded).toContain('70,468 tokens');
          expect(expanded).toContain('28m 58s');
        } else expect(expanded).toContain(fixture.args.operations[0].description.slice(0, 60));
        for (const width of [24, 80]) {
          for (const line of row.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        }
      }
      expect(JSON.stringify(fixture)).toBe(original);
    }
  });

  it.each([
    ['Operation 1: Updated task #3 status', { action: 'update', taskId: '3', status: 'in_progress' }, '◉ #3 In progress', '\x1b[36m◉'],
    ['Operation 1: Updated task #3 status', { action: 'update', taskId: '3', status: 'pending' }, '○ #3 Pending', '\x1b[2m○'],
    ['Operation 1: Updated task #3 status', { action: 'update', taskId: '3', status: 'completed' }, '✓ #3 Completed', '\x1b[32m✓'],
    ['Operation 1: Updated task #3 description', { action: 'update', taskId: '3', description: 'Revised' }, '• #3 Updated', '\x1b[2m•'],
    ['Operation 1: Updated task #3 deleted', { action: 'delete', taskId: '3' }, '× #3 Deleted', '\x1b[2m×'],
    ['Updated #3: subject', { action: 'update', taskId: '3', subject: 'Renamed' }, '• #3 Renamed', '\x1b[2m•'],
    ['Deleted #3: Removed task', { action: 'delete', taskId: '3' }, '× #3 Removed task', '\x1b[2m×'],
    ['Created #3: New task', { action: 'create', status: 'completed' }, '✓ #3 New task', '\x1b[32m✓'],
  ])('styles saved acknowledgements: %s', async (text, operation, expected, color) => {
    const { write } = await setup('render-old-statuses');
    const result = { content: [{ type: 'text', text }] };
    const output = renderResult(write, result, { operations: [operation] }, { theme: ansiTheme }).join('\n');
    expect(stripTerminalSequences(output)).toContain(expected);
    expect(output).toContain(color);
    expect(output).not.toContain('Operation');
  });

  it('preserves legacy warnings and unknown messages without fabricating success', async () => {
    const { write } = await setup('render-old-warnings');
    const args = { operations: [{ action: 'update', taskId: '3', addBlockedBy: ['3', '999'] }] };
    const warning = { content: [{ type: 'text', text: 'Operation 1: Updated task #3 blockedBy\nWarnings: operation 1: #3 blocks itself; operation 1: #999 does not exist' }] };
    const output = renderResult(write, warning, args, { theme: ansiTheme }).join('\n');
    expect(stripTerminalSequences(output)).toContain('• #3 Updated');
    expect(stripTerminalSequences(output)).toContain('! #3: #3 blocks itself; #3: #999 does not exist');
    expect(output).toContain('\x1b[33m');
    for (const text of ['task_write failed: operation 1 update task #99 not found\nNo changes were committed.', 'Unrecognized historical result']) {
      const result = { content: [{ type: 'text', text }] };
      const rendered = renderResult(write, result, { operations: [{ action: 'update', taskId: '99', status: 'completed' }] }, { expanded: true, theme: ansiTheme }).join('\n');
      expect(stripTerminalSequences(rendered)).toBe(text);
      expect(rendered).not.toContain('✓');
      if (text.startsWith('task_write failed')) expect(rendered).toContain('\x1b[31m');
    }
  });

  it('does not borrow status from an unrelated argument or the live task store', async () => {
    const { mock, ctx, write } = await setup('render-old-unknown-status');
    await mock.execute('task_write', { operations: [{ action: 'create', subject: 'Current title', description: 'Desc', status: 'completed' }] }, ctx);
    const result = { content: [{ type: 'text', text: 'Operation 1: Updated task #1 description' }] };
    const text = plain(renderResult(write, result, { operations: [{ action: 'update', taskId: '99', status: 'completed' }] })).join('\n');
    expect(text).toBe('  • #1 Updated');
    expect(text).not.toContain('Current title');
  });

  it('restores list details, blockers, empty states, and the ten-row overflow hint', async () => {
    const { list } = await setup('render-old-list-details');
    const detail = 'Task #3: Ship · mobile\nstatus: completed\ndescription: Test release\noutput: 1,234 tokens\nmetadata: {"owner":"parent"}';
    const result = { content: [{ type: 'text', text: detail }] };
    expect(plain(renderResult(list, result, { taskId: '3' }))).toEqual(['  ✓ #3 Ship · mobile']);
    const expanded = plain(renderResult(list, result, {}, { expanded: true })).join('\n');
    for (const line of detail.split('\n').slice(1)) expect(expanded).toContain(line);
    const overview = Array.from({ length: 14 }, (_, index) => `#${index + 1} [pending] Ship · mobile [blocked by #20, #21] · 2m 58s · 13 tools · 1,864 tokens`).join('\n');
    const oldList = { content: [{ type: 'text', text: overview }] };
    const previousKeys = getKeybindings();
    setKeybindings(new KeybindingsManager({ 'app.tools.expand': 'ctrl+e' }));
    try {
      const compact = plain(renderResult(list, oldList, {}));
      expect(compact).toHaveLength(11);
      expect(compact[0]).toBe('  ○ #1 Ship · mobile [blocked by #20, #21]');
      expect(compact[10]).toBe('  ctrl+e to expand 4 more tasks');
      expect(compact.join('\n')).not.toContain('tokens');
      expect(plain(renderResult(list, oldList, {}, { expanded: true })).join('\n')).toContain('#14 Ship · mobile');
    } finally { setKeybindings(previousKeys); }
    expect(plain(renderResult(list, { content: [{ type: 'text', text: 'No tasks found' }] }, {}))).toEqual(['  No tasks']);
    const missing = renderResult(list, { content: [{ type: 'text', text: 'Task #99 not found' }] }, {}, { theme: ansiTheme }).join('\n');
    expect(missing).toContain('\x1b[31m');
    expect(stripTerminalSequences(missing)).toBe('Task #99 not found');
  });

  it('renders a compact write checklist without operation labels or success prose', async () => {
    const { mock, ctx, write } = await setup('render-write-compact');
    const args = {
      operations: [
        { action: 'create', subject: 'Inspect rendering', description: 'Look at current output' },
        { action: 'create', subject: 'Implement compact output', description: 'Ship checklist' },
      ],
    };
    const result = await mock.execute('task_write', args, ctx);
    expect(result.content[0].text).toBe('Created #1: Inspect rendering\nCreated #2: Implement compact output');
    expect(result.content[0].text).not.toContain('Operation');
    expect(result.content[0].text).not.toContain('successfully');

    const call = renderCall(write, args);
    expect(call.join('\n')).toContain('▸ Create tasks · 2 changes');

    const rows = plain(renderResult(write, result, args));
    expect(rows.some((line) => line.includes('○ #1 Inspect rendering'))).toBe(true);
    expect(rows.some((line) => line.includes('○ #2 Implement compact output'))).toBe(true);
    expect(rows.join('\n')).not.toContain('✓');
    expect(rows.join('\n')).not.toContain('Look at current output');
    expect(rows.join('\n')).not.toMatch(/expand/i);
  });

  it('keeps actual task status after a successful write and distinguishes delete from complete', async () => {
    const { mock, ctx, write } = await setup('render-status');
    await mock.execute('task_write', { operations: [{ action: 'create', subject: 'Keep pending', description: 'Desc' }] }, ctx);
    await mock.execute('task_write', { operations: [{ action: 'create', subject: 'Finish me', description: 'Desc' }] }, ctx);
    const completed = await mock.execute('task_write', { operations: [{ action: 'update', taskId: '2', status: 'completed' }] }, ctx);
    const deleted = await mock.execute('task_write', { operations: [{ action: 'delete', taskId: '1' }] }, ctx);

    const completedRows = plain(renderResult(write, completed, { operations: [{ action: 'update', taskId: '2', status: 'completed' }] })).join('\n');
    expect(completedRows).toContain('✓ #2 Finish me');
    expect(completedRows).not.toContain('○ #2');

    const deletedRows = plain(renderResult(write, deleted, { operations: [{ action: 'delete', taskId: '1' }] })).join('\n');
    expect(deletedRows).toContain('× #1 Keep pending');
    expect(deletedRows).not.toContain('✓ #1');
    expect(deleted.content[0].text).toContain('Deleted #1: Keep pending');
  });

  it('folds multiple operations on the same id to the final snapshot', async () => {
    const { mock, ctx, write } = await setup('render-same-id');
    const args = {
      operations: [
        { action: 'create', subject: 'Draft', description: 'First' },
        { action: 'update', taskId: '1', subject: 'Final title', status: 'in_progress' },
      ],
    };
    const result = await mock.execute('task_write', args, ctx);
    expect(result.content[0].text).toBe('Created #1: Draft\nUpdated #1: status, subject');
    const rows = plain(renderResult(write, result, args));
    const joined = rows.join('\n');
    expect(joined).toContain('◉ #1 Final title');
    expect(joined).not.toContain('Draft');
    expect(rows.filter((line) => line.includes('#1')).length).toBe(1);
  });

  it('renders historical snapshots after later writes change the live store', async () => {
    const { mock, ctx, write } = await setup('render-history');
    const first = await mock.execute('task_write', { operations: [{ action: 'create', subject: 'Original', description: 'Old desc' }] }, ctx);
    await mock.execute('task_write', { operations: [{ action: 'update', taskId: '1', subject: 'Renamed', description: 'New desc' }] }, ctx);
    const historical = plain(renderResult(write, first, { operations: [{ action: 'create', subject: 'Original', description: 'Old desc' }] }));
    expect(historical.join('\n')).toContain('○ #1 Original');
    expect(historical.join('\n')).not.toContain('Renamed');
    const expanded = plain(renderResult(write, first, { operations: [{ action: 'create', subject: 'Original', description: 'Old desc' }] }, { expanded: true }));
    expect(expanded.join('\n')).toContain('description: Old desc');
    expect(expanded.join('\n')).not.toContain('New desc');
  });

  it('caps large lists with an accurate more count and reveals everything when expanded', async () => {
    const { mock, ctx, list } = await setup('render-cap');
    const operations = Array.from({ length: 12 }, (_, index) => ({
      action: 'create',
      subject: 'Task ' + (index + 1),
      description: 'Description ' + (index + 1),
    }));
    await mock.execute('task_write', { operations }, ctx);
    const result = await mock.execute('task_list', {}, ctx);
    const compact = plain(renderResult(list, result, {}));
    const compactText = compact.join('\n');
    expect(compactText).toContain('○ #1 Task 1');
    expect(compactText).toContain('expand 2 more tasks');
    expect(compactText).toMatch(/expand 2 more tasks/);
    expect(compactText).not.toContain('Task 12');
    expect(compactText).not.toContain('Description 1');

    const expanded = plain(renderResult(list, result, {}, { expanded: true }));
    const expandedText = expanded.join('\n');
    expect(expandedText).toContain('Task 12');
    expect(expandedText).toContain('description: Description 12');
    expect(expandedText).not.toContain('expand 2 more tasks');
  });

  it('renders empty, missing, failed, partial, and legacy results without crashing', async () => {
    const { mock, ctx, write, list } = await setup('render-edges');

    const empty = await mock.execute('task_list', {}, ctx);
    expect(plain(renderResult(list, empty, {})).join('\n')).toContain('No tasks');
    expect(renderCall(list, {}).join('\n')).toContain('▸ List tasks');

    const missing = await mock.execute('task_list', { taskId: '99' }, ctx);
    expect(plain(renderResult(list, missing, { taskId: '99' })).join('\n')).toContain('Task #99 not found');
    expect(renderCall(list, { taskId: '99' }).join('\n')).toContain('▸ Read task · #99');

    const failed = await mock.execute('task_write', { operations: [{ action: 'update', taskId: '99', status: 'completed' }] }, ctx);
    expect(failed.details.taskWriteFailed).toBe(true);
    const failedText = plain(renderResult(write, failed, { operations: [{ action: 'update', taskId: '99', status: 'completed' }] })).join('\n');
    expect(failedText).toContain('task_write failed');
    expect(failedText).toContain('operation 1 update task #99 not found');
    expect(failedText).not.toContain('✓');

    expect(() => renderCall(write, undefined)).not.toThrow();
    expect(() => renderCall(write, { operations: 'nope' })).not.toThrow();
    expect(() => renderCall(write, { operations: [{ action: 'create' }] })).not.toThrow();
    const partialCall = renderCall(write, { operations: [{ action: 'create' }] }, 80, identityTheme, { isPartial: true });
    expect(partialCall.join('\n')).toContain('▸ Create tasks');
    expect(partialCall.join('\n')).not.toContain('✓');

    const partialResult = renderResult(write, { content: [], details: undefined }, { operations: [{ action: 'create' }] }, { isPartial: true });
    expect(partialResult).toEqual([]);

    const legacy = renderResult(write, { content: [{ type: 'text', text: 'Operation 1: Task #1 created successfully: Legacy' }], details: undefined }, {});
    expect(plain(legacy).join('\n')).toContain('• #1 Legacy');
    expect(plain(legacy).join('\n')).not.toContain('Operation');
  });

  it('truncates compact ANSI rows to the requested width and wraps expanded long content', async () => {
    const { mock, ctx, write } = await setup('render-width');
    const subject = 'Inspect rendering 日本語 🧪 ' + 'x'.repeat(80);
    const description = 'A very long description ' + 'y'.repeat(120);
    const args = { operations: [{ action: 'create', subject, description }] };
    const result = await mock.execute('task_write', args, ctx);

    const compact = renderResult(write, result, args, { width: 24, theme: ansiTheme });
    expect(compact.length).toBeGreaterThan(0);
    for (const line of compact) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(24);
    }

    const expanded = renderResult(write, result, args, { width: 28, theme: ansiTheme, expanded: true });
    expect(plain(expanded).join('\n')).toContain('description:');
    for (const line of expanded) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(28);
    }
  });

  it('shows no-op updates and useful blockers without implying completion', async () => {
    const { mock, ctx, write } = await setup('render-noop');
    await mock.execute('task_write', { operations: [{ action: 'create', subject: 'Blocker', description: 'Desc' }] }, ctx);
    await mock.execute('task_write', { operations: [{ action: 'create', subject: 'Blocked', description: 'Desc' }] }, ctx);
    const blocked = await mock.execute('task_write', { operations: [{ action: 'update', taskId: '2', addBlockedBy: ['1'] }] }, ctx);
    const noop = await mock.execute('task_write', { operations: [{ action: 'update', taskId: '2' }] }, ctx);

    const blockedText = plain(renderResult(write, blocked, { operations: [{ action: 'update', taskId: '2', addBlockedBy: ['1'] }] })).join('\n');
    expect(blockedText).toContain('○ #2 Blocked');
    expect(blockedText).toContain('[blocked by #1]');
    expect(blockedText).not.toContain('✓ #2');

    const noopText = plain(renderResult(write, noop, { operations: [{ action: 'update', taskId: '2' }] })).join('\n');
    expect(noopText).toContain('no changes');
    expect(noopText).toContain('○ #2 Blocked');
    expect(noop.content[0].text).toContain('Updated #2: no changes');
  });
  it('attributes dependency warnings to each affected task', async () => {
    const { mock, ctx, write } = await setup('render-warnings');
    await mock.execute('task_write', { operations: [
      { action: 'create', subject: 'One', description: 'First' },
      { action: 'create', subject: 'Two', description: 'Second' },
    ] }, ctx);
    const args = { operations: [
      { action: 'update', taskId: '1', addBlockedBy: ['999'] },
      { action: 'update', taskId: '2', addBlockedBy: ['999'] },
    ] };
    const result = await mock.execute('task_write', args, ctx);
    for (const id of ['1', '2']) {
      expect(result.content[0].text).toContain(`Warning #${id}: #999 does not exist`);
      expect(plain(renderResult(write, result, args)).join('\n')).toContain(`#${id}: #999 does not exist`);
    }
  });

  it('retains all existing read details when expanded', async () => {
    const { mock, ctx, list } = await setup('render-detail-stats');
    await mock.execute('task_write', { operations: [
      { action: 'create', subject: 'Inspect', description: 'Details', status: 'completed', metadata: { owner: 'parent' } },
    ] }, ctx);
    const args = { taskId: '1' };
    const result = await mock.execute('task_list', args, ctx);
    const expanded = plain(renderResult(list, result, args, { width: 180, expanded: true })).join('\n');
    for (const line of result.content[0].text.split('\n').slice(1)) expect(expanded).toContain(line);
  });

  it('normalizes multiline titles in compact mode and respects zero width', async () => {
    const { mock, ctx, write } = await setup('render-multiline');
    const args = { operations: [{ action: 'create', subject: 'First\nSecond', description: 'Details' }] };
    const result = await mock.execute('task_write', args, ctx);
    const compact = plain(renderResult(write, result, args));
    expect(compact.join('\n')).toContain('First Second');
    expect(compact.every((line) => !line.includes('\n'))).toBe(true);
    expect(renderResult(write, result, args, { width: 0 })).toEqual([]);
  });

  it('renders through Pi tool rows with real themes, expansion, and remapped keys', async () => {
    const { mock, ctx, write } = await setup('render-pi-row');
    const args = { operations: [
      { action: 'create', subject: 'Inspect rendering', description: 'Compare reference tools', status: 'completed' },
      { action: 'create', subject: 'Implement compact output', description: 'Verify task rows', status: 'in_progress' },
    ] };
    const result = await mock.execute('task_write', args, ctx);
    const previousKeys = getKeybindings();
    setKeybindings(new KeybindingsManager({ 'app.tools.expand': 'ctrl+e' }));
    try {
      initTheme('dark', false);
      const row = new ToolExecutionComponent('task_write', 'render-call', args, {}, write,
        { requestRender() {} } as any, '/tmp');
      row.markExecutionStarted();
      row.setArgsComplete();
      row.updateResult({ ...result, isError: false });
      for (const themeName of ['dark', 'light']) {
        initTheme(themeName, false);
        row.invalidate();
        row.setExpanded(false);
        const compact = plain(row.render(80)).map((line) => line.trimEnd()).join('\n');
        expect(compact).toContain('▸ Create tasks · 2 changes');
        expect(compact).toContain('✓ #1 Inspect rendering');
        expect(compact).toContain('◉ #2 Implement compact output');
        expect(compact).not.toContain('ctrl+e');
        expect(compact).not.toContain('Compare reference tools');
        expect(compact).not.toContain('Created #1');
        row.setExpanded(true);
        expect(plain(row.render(80)).join('\n')).toContain('description: Compare reference tools');
        for (const width of [24, 40, 80]) {
          for (const line of row.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        }
      }
    } finally {
      setKeybindings(previousKeys);
    }
  });

  it('keeps create-then-noop and status-deletion batches honest', async () => {
    const { mock, ctx, write } = await setup('render-batch-delete');
    const args = { operations: [
      { action: 'create', subject: 'New task', description: 'Details' },
      { action: 'update', taskId: '1' },
      { action: 'update', taskId: '1' },
    ] };
    const created = await mock.execute('task_write', args, ctx);
    expect(plain(renderResult(write, created, args)).join('\n')).not.toContain('no changes');
    const deleted = await mock.execute('task_write', { operations: [
      { action: 'update', taskId: '1', status: 'deleted' },
    ] }, ctx);
    const expanded = plain(renderResult(write, deleted, {}, { expanded: true })).join('\n');
    expect(expanded).toContain('× #1 New task');
    expect(expanded).toContain('status: deleted');
    expect(expanded).not.toContain('status: pending');
    const temporary = await mock.execute('task_write', { operations: [
      { action: 'create', subject: 'Temporary task', description: 'Details' },
      { action: 'delete', taskId: '2' },
    ] }, ctx);
    expect(plain(renderResult(write, temporary, {})).join('\n')).toContain('× #2 Temporary task');
  });

  it.each([
    [{ action: 'create' }, 'Create tasks'],
    [{ action: 'update', status: 'in_progress' }, 'Start tasks'],
    [{ action: 'update', status: 'completed' }, 'Complete tasks'],
    [{ action: 'update', status: 'pending' }, 'Queue tasks'],
    [{ action: 'update', subject: 'Renamed' }, 'Update tasks'],
    [{ action: 'delete' }, 'Delete tasks'],
    [{ action: 'update', status: 'deleted' }, 'Delete tasks'],
    [{}, 'Update tasks'],
  ])('tailors headers for %j', async (operation, title) => {
    const { write } = await setup('render-action-header');
    expect(renderCall(write, { operations: [operation] }).join('\n')).toBe(`▸ ${title} · 1 change`);
    expect(renderCall(write, operation).join('\n')).toContain(`▸ ${title}`);
    expect(renderCall(write, { operations: [operation, operation] }).join('\n')).toBe(`▸ ${title} · 2 changes`);
  });

  it('keeps mixed and malformed batch headers neutral', async () => {
    const { write } = await setup('render-mixed-header');
    for (const operations of [
      [{ action: 'create' }, { action: 'update', status: 'completed' }],
      [{ action: 'create' }, null],
      [{ action: 'delete' }, { action: 'update', status: 'in_progress' }],
    ]) expect(renderCall(write, { operations }).join('\n')).toBe('▸ Update tasks · 2 changes');
    expect(renderCall(write, undefined)).toEqual(['▸ Update tasks']);
  });

  it.each([1, 10, 11, 14])('shows an overflow-only hint for %i task rows', async (count) => {
    const { mock, ctx, write, list } = await setup('render-hint-threshold');
    const previousKeys = getKeybindings();
    setKeybindings(new KeybindingsManager({ 'app.tools.expand': 'ctrl+e' }));
    try {
      const args = { operations: Array.from({ length: count }, (_, index) => ({
        action: 'create', subject: `Task ${index + 1}`, description: 'Details',
      })) };
      const result = await mock.execute('task_write', args, ctx);
      const listed = await mock.execute('task_list', {}, ctx);
      for (const [tool, output] of [[write, result], [list, listed]]) {
        const compact = plain(renderResult(tool, output, args));
        expect(compact.filter((line) => line.includes('○ #'))).toHaveLength(Math.min(count, 10));
        if (count > 10) {
          expect(compact.join('\n')).toContain(`ctrl+e to expand ${count - 10} more task${count === 11 ? '' : 's'}`);
        } else expect(compact.join('\n')).not.toMatch(/expand/i);
        const expanded = plain(renderResult(tool, output, args, { expanded: true }));
        expect(expanded.filter((line) => line.includes('○ #'))).toHaveLength(count);
        expect(expanded.join('\n')).not.toContain('ctrl+e');
      }
    } finally {
      setKeybindings(previousKeys);
    }
  });

});
