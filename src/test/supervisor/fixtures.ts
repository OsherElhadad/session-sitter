/**
 * Shared fixtures for the supervisor tests: a controllable clock, transcript exports, valid
 * assessments, a temp knowledge repo, and a fully wired orchestrator over temp state.
 *
 * Mirrors `supervisor/tests/fixtures.py` from the original Python suite, so the ported behavior
 * is exercised at the same seams.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OutboxAgentController } from '../../supervisor/agentControl';
import { SupervisorConfig, ensureDirs, historyDir, outboxDir, recordsDir } from '../../supervisor/config';
import { ClassifierEngine } from '../../supervisor/engine';
import { FetchFn, Tier } from '../../supervisor/knowledge';
import { FakeChannel, MessagingChannel } from '../../supervisor/messaging';
import { Orchestrator } from '../../supervisor/orchestrator';
import { StateStore } from '../../supervisor/store';
import { FileTranscriptSource } from '../../supervisor/transcript';

/** A controllable clock for timeout tests. */
export class MutableClock {
  now: Date;

  constructor(start = new Date('2026-07-14T10:00:00.000Z')) {
    this.now = start;
  }

  /** Usable directly as a `Clock`. */
  readonly get = (): Date => this.now;

  advance(minutes: number): void {
    this.now = new Date(this.now.getTime() + minutes * 60_000);
  }
}

export function makeTmpDir(prefix = 'supervisor-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export const TEAM = 'platform';
export const PROJECT = 'demo-project';
export const USER = 'alice';

/** A tier file with one intention the classifier could act on. */
export function bottomLine(tier: string, id: string, level = 'orange'): string {
  return `---
scope: ${tier}
owner: ${tier === 'user' ? USER : tier === 'project' ? PROJECT : TEAM}
---

# Bottom line — ${tier}

### Belief: Pushes to main go through a reviewed PR

| Field | Value |
|---|---|
| id | ${id} |
| level | ${level} |
| confidence | high |
| tags | git, review |
| source | ${tier}-convention |

The team merges through pull requests; direct pushes to main bypass review.

---

### Intention: Ask before pushing to a protected branch

| Field | Value |
|---|---|
| id | ${id}-int |
| level | ${level} |
| confidence | medium |

Trigger: the agent proposes \`git push\` to main.
Action: raise it with the developer.
`;
}

/** Create a temp knowledge repo holding all three tier files. Returns its root. */
export function makeKnowledgeRepo(root = makeTmpDir('knowledge-')): string {
  const write = (rel: string, body: string): void => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf8');
  };
  write(`data/knowledge/teams/${TEAM}/bottom-line.md`, bottomLine('team', 'team-b1', 'orange'));
  write(`data/knowledge/projects/${PROJECT}/bottom-line.md`, bottomLine('project', 'proj-b1', 'yellow'));
  write(`data/knowledge/users/${USER}/bottom-line.md`, bottomLine('user', 'user-b1', 'green'));
  return root;
}

/** A fetch that reads a local knowledge repo — no git, no network. */
export function localFetch(knowledgeRoot: string): FetchFn {
  return async (user, project, team) => {
    const slugs: Record<Tier, string> = { user, project, team };
    const folder: Record<Tier, string> = { team: 'teams', project: 'projects', user: 'users' };
    const out = {} as Record<Tier, { slug: string; path_in_repo: string; exists: boolean; content: string | null }>;
    for (const tier of ['team', 'project', 'user'] as Tier[]) {
      const rel = `data/knowledge/${folder[tier]}/${slugs[tier]}/bottom-line.md`;
      const full = path.join(knowledgeRoot, rel);
      const exists = fs.existsSync(full);
      out[tier] = {
        slug: slugs[tier],
        path_in_repo: rel,
        exists,
        content: exists ? fs.readFileSync(full, 'utf8') : null,
      };
    }
    return out;
  };
}

export const SESSION_ID = 'legacy-bob-code-abc123';

export interface MakeExportOptions {
  sessionId?: string;
  source?: string;
  user?: string;
  projectName?: string;
  projectPath?: string;
  status?: string;
  pendingKind?: string;
  pendingName?: string;
  pendingArgs?: Record<string, unknown> | null;
  pendingPermission?: string;
  pendingDescription?: string;
  pendingRequestId?: string | null;
  waitingReason?: string;
  originalRequest?: string;
  /** Drop the pending action entirely. */
  noPending?: boolean;
}

/** A minimal but complete transcript export (the history-export contract). */
export function makeExport(opts: MakeExportOptions = {}): Record<string, unknown> {
  const originalRequest = opts.originalRequest ?? 'Fix the failing test in auth.py';
  const pendingName = opts.pendingName ?? 'execute_command';
  const pendingArgs = opts.pendingArgs === undefined
    ? { command: 'git push origin main' } : opts.pendingArgs;
  const pendingPermission = opts.pendingPermission ?? 'execute';
  const pending = opts.noPending ? null : {
    kind: opts.pendingKind ?? 'tool_call',
    name: pendingName,
    arguments: pendingArgs,
    permission: pendingPermission,
    description: opts.pendingDescription ?? 'Run `git push origin main`',
    turnIndex: 1,
    requestId: opts.pendingRequestId ?? null,
  };
  return {
    schemaVersion: '1.0',
    sessionId: opts.sessionId ?? SESSION_ID,
    source: opts.source ?? 'bob',
    user: opts.user ?? USER,
    projectName: opts.projectName ?? PROJECT,
    projectPath: opts.projectPath ?? `/home/${USER}/${PROJECT}`,
    status: opts.status ?? 'waiting',
    approvalConfig: null,
    title: originalRequest.slice(0, 60),
    turns: [
      { index: 0, role: 'user', text: originalRequest, timestamp: '2026-07-14T10:00:00Z' },
      {
        index: 1,
        role: 'assistant',
        text: "I'll run the command.",
        timestamp: '2026-07-14T10:01:00Z',
        toolCalls: [
          { id: 'tooluse_1', name: pendingName, arguments: pendingArgs, permission: pendingPermission },
        ],
      },
    ],
    pendingAction: pending,
    waitingReason: opts.waitingReason ?? 'Awaiting approval to run a command.',
  };
}

export function writeExport(dir: string, exported: Record<string, unknown>): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${String(exported.sessionId)}.json`);
  fs.writeFileSync(p, JSON.stringify(exported), 'utf8');
  return p;
}

/** A valid classifier assessment for the given traffic light. */
export function assessment(
  light: string, overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    traffic_light: light,
    confidence: 0.85,
    summary: `${light} assessment`,
    agent_intent: 'Run git push origin main',
    user_intent: 'Fix the failing test',
    waiting_reason: 'Awaiting approval to run a command.',
    issues: [],
    recommended_action: 'See message.',
    supervisor_message_to_agent: null,
    human_notification: null,
    human_options: [],
    allowed_actions_while_waiting: [],
    blocked_actions: [],
    should_block_agent: false,
    should_block_original_action: false,
    transitioned_from: null,
    transition_reason: null,
  };
  if (light === 'yellow') {
    base.supervisor_message_to_agent = 'Prefer a PR over pushing to main.';
  } else if (light === 'orange') {
    base.human_notification = 'The agent wants to push directly to main; this needs your call.';
    base.blocked_actions = ['git push origin main'];
    base.allowed_actions_while_waiting = ['run tests', 'prepare a PR draft'];
    base.should_block_original_action = true;
    base.human_options = ['Approve', 'Create PR', 'Cancel'];
  } else if (light === 'red') {
    base.should_block_agent = true;
    base.blocked_actions = ['rm -rf /'];
    base.human_notification = 'The agent attempted a destructive command.';
    base.human_options = ['Keep blocked', 'Unblock'];
  }
  return { ...base, ...overrides };
}

export function makeConfig(stateDir: string, overrides: Partial<SupervisorConfig> = {}): SupervisorConfig {
  return {
    workspaceRoot: stateDir,
    stateDir,
    orangeResponseTimeoutMinutes: 30,
    supervisorEngine: 'bob',
    claudeCliPath: 'claude',
    classifierTimeoutSeconds: 300,
    bobCliPath: 'bob',
    bobShellApiKey: null,
    anthropicBaseUrl: null,
    anthropicAuthToken: null,
    messagingChannel: 'stub',
    redNotify: true,
    telegramBotToken: null,
    telegramChatId: null,
    knowledgeRegistryPath: '',
    knowledgeLocalRepo: '',
    knowledgeRepo: '',
    knowledgeRef: 'main',
    ...overrides,
  };
}

export interface TestRig {
  orch: Orchestrator;
  store: StateStore;
  channel: FakeChannel;
  config: SupervisorConfig;
  clock: MutableClock;
  knowledgeRoot: string;
  /** Every delivery written to the outbox, parsed. */
  deliveries(): Array<Record<string, unknown>>;
}

/** Wire an Orchestrator against temp state + a temp knowledge repo. */
export function buildTestOrchestrator(
  stateDir: string,
  engine: ClassifierEngine,
  opts: {
    channel?: MessagingChannel;
    clock?: MutableClock;
    exported?: Record<string, unknown> | null;
    knowledgeRoot?: string;
    configOverrides?: Partial<SupervisorConfig>;
  } = {},
): TestRig {
  const clock = opts.clock ?? new MutableClock();
  const knowledgeRoot = opts.knowledgeRoot ?? makeKnowledgeRepo();
  const config = makeConfig(stateDir, opts.configOverrides);
  ensureDirs(config);
  writeExport(historyDir(config), opts.exported ?? makeExport());

  const store = new StateStore(recordsDir(config), undefined, clock.get);
  const channel = (opts.channel ?? new FakeChannel(false, clock.get)) as FakeChannel;
  // The real transcript source is used on purpose: reading and validating the export contract is
  // part of what these tests cover.
  const orch = new Orchestrator({
    config,
    store,
    transcriptSource: new FileTranscriptSource(historyDir(config)),
    engine,
    channel,
    agentController: new OutboxAgentController(outboxDir(config)),
    clock: clock.get,
    knowledgeFetch: localFetch(knowledgeRoot),
  });

  return {
    orch,
    store,
    channel,
    config,
    clock,
    knowledgeRoot,
    deliveries: () => {
      const dir = outboxDir(config);
      return fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .sort()
        .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Record<string, unknown>);
    },
  };
}
