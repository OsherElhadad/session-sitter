// Synthetic fixtures for the screenshot harness.
//
// PRIVACY RULE — every value in this file is invented. Nothing here is read from, derived from, or
// sampled out of ~/.claude/sessions, ~/.claude/projects, ~/.claude/history.jsonl or any other real
// session store. The PNGs these fixtures produce are committed and published in the README, so a
// real project name, path or message leaking in here would leak into the README with it. Keep the
// projects fictional (acme-api, checkout-service, docs-site, ledger-worker) and keep the prose
// obviously made up.

/** Minutes → an ISO timestamp that many minutes before `now`, so relative labels stay stable. */
const ago = (now, minutes) => new Date(now - minutes * 60_000).toISOString();

/**
 * The `updateSessions` payload — the worklist. Covers all four sources, the three status states,
 * three coloured workspace pills, one uncoloured pill, the "(no workspace)" fallback, and one
 * session on another machine.
 */
export function sessions(now) {
  return [
    {
      sessionId: 'ss-fixture-0001',
      title: 'Wire the retry budget into the payments client',
      projectName: 'acme-api',
      projectPath: '/home/dev/work/acme-api',
      updatedAt: ago(now, 2),
      status: 'active',
      source: 'claude',
      workspaceColor: { background: '#2e7d32', foreground: '#ffffff' },
    },
    {
      sessionId: 'ss-fixture-0002',
      title: 'Trace the double-charge on cart abandon',
      projectName: 'checkout-service',
      projectPath: '/home/dev/work/checkout-service',
      updatedAt: ago(now, 6),
      status: 'waiting',
      source: 'bob',
      workspaceColor: { background: '#c0392b', foreground: '#ffffff' },
    },
    {
      sessionId: 'ss-fixture-0003',
      title: 'Rewrite the getting-started page',
      projectName: 'docs-site',
      projectPath: '/home/dev/work/docs-site',
      updatedAt: ago(now, 24),
      status: 'idle',
      source: 'codex',
      workspaceColor: { background: '#64748b', foreground: '#ffffff' },
    },
    {
      sessionId: 'ss-fixture-0004',
      title: 'Explain the feature-flag rollout helper',
      projectName: 'acme-api',
      projectPath: '/home/dev/work/acme-api',
      updatedAt: ago(now, 51),
      status: 'idle',
      source: 'chat',
    },
    {
      sessionId: 'ss-fixture-0005',
      title: 'Backfill the reconciliation index',
      projectName: 'ledger-worker',
      projectPath: '/srv/build/ledger-worker',
      updatedAt: ago(now, 9),
      status: 'active',
      source: 'claude',
      peer: 'dev@build-box.example',
      workspaceColor: { background: '#6d28d9', foreground: '#ffffff' },
    },
    {
      sessionId: 'ss-fixture-0006',
      title: 'Scratch: bisect the flaky timer test',
      projectName: '',
      projectPath: '',
      updatedAt: ago(now, 3 * 60),
      status: 'idle',
      source: 'claude',
    },
  ];
}

/** The `updateHistory` payload — a couple of finished sessions, so the drawer is not empty. */
export function history(now) {
  return [
    {
      sessionId: 'ss-fixture-0101',
      title: 'Split the invoice PDF renderer out of the API',
      projectName: 'acme-api',
      projectPath: '/home/dev/work/acme-api',
      updatedAt: ago(now, 2 * 24 * 60),
      status: 'idle',
      source: 'claude',
      workspaceColor: { background: '#2e7d32', foreground: '#ffffff' },
    },
    {
      sessionId: 'ss-fixture-0102',
      title: 'Add the idempotency-key middleware',
      projectName: 'checkout-service',
      projectPath: '/home/dev/work/checkout-service',
      updatedAt: ago(now, 5 * 24 * 60),
      status: 'idle',
      source: 'bob',
      workspaceColor: { background: '#c0392b', foreground: '#ffffff' },
    },
  ];
}

/** The `updateSessions` peers list — one reachable machine, matching the peer row above. */
export const peers = [
  { peer: 'dev@build-box.example', reachable: true, sessionCount: 1 },
];

/**
 * The `updateActivity` payload — one decision of each traffic light, plus the two attributions
 * (a deterministic rule and the supervisor). Newest first, the order the feed expects.
 */
export function activity(now) {
  return [
    {
      requestId: 'req-fixture-a1',
      at: ago(now, 1),
      sessionId: 'ss-fixture-0002',
      sessionName: 'Trace the double-charge on cart abandon',
      host: 'build-box',
      light: 'orange',
      summary: 'rewriting the migration that renames charges.amount',
      userIntent: 'find out why some carts charge twice',
      agentIntent: 'edit db/migrations/0042_rename_amount.sql',
      humanNotification: 'This rewrites a migration that has already run on staging. Renaming the '
        + 'column in place would break the replica that still reads the old name.',
      options: ['Add a new column instead', 'Rename it anyway', 'Leave it to me'],
      state: 'orange_awaiting_user',
      awaitLight: 'orange',
      userResponse: null,
      error: null,
      decidedBy: 'supervisor',
      ruleLabel: '',
    },
    {
      requestId: 'req-fixture-a2',
      at: ago(now, 4),
      sessionId: 'ss-fixture-0001',
      sessionName: 'Wire the retry budget into the payments client',
      host: 'laptop',
      light: 'green',
      summary: 'reading src/payments/retryBudget.ts',
      userIntent: 'cap the retries per payment attempt',
      agentIntent: 'read a source file in the workspace',
      humanNotification: '',
      options: [],
      state: 'green_completed',
      awaitLight: null,
      userResponse: null,
      error: null,
      decidedBy: 'supervisor',
      ruleLabel: '',
    },
    {
      requestId: 'req-fixture-a3',
      at: ago(now, 12),
      sessionId: 'ss-fixture-0003',
      sessionName: 'Rewrite the getting-started page',
      host: 'laptop',
      light: 'yellow',
      summary: 'installing a markdown linter globally',
      userIntent: 'tidy up the docs headings',
      agentIntent: 'run npm install -g some-linter',
      humanNotification: 'Answered for you: install it as a dev dependency in this repo instead of '
        + 'globally, so the docs build is reproducible.',
      options: [],
      state: 'yellow_delivered',
      awaitLight: null,
      userResponse: null,
      error: null,
      decidedBy: 'rule',
      ruleLabel: 'npm install -g* → auto-replied',
    },
    {
      requestId: 'req-fixture-a4',
      at: ago(now, 38),
      sessionId: 'ss-fixture-0005',
      sessionName: 'Backfill the reconciliation index',
      host: 'build-box',
      light: 'red',
      summary: 'dropping the ledger_staging database',
      userIntent: 'rebuild the reconciliation index from scratch',
      agentIntent: 'run dropdb ledger_staging && createdb ledger_staging',
      humanNotification: 'Blocked. Destroying the staging database is not reversible and nothing in '
        + 'the request asked for it. The index can be rebuilt with REINDEX instead.',
      options: [],
      state: 'red_blocked',
      awaitLight: null,
      userResponse: null,
      error: null,
      decidedBy: 'supervisor',
      ruleLabel: '',
    },
  ];
}

/** Answers for the `getSessionPreview` request, keyed by session id — the hover preview card. */
export function previews(now) {
  return {
    'ss-fixture-0001': {
      projectPath: '/home/dev/work/acme-api',
      exchanges: [
        {
          role: 'user',
          text: 'Cap the retries per payment attempt — right now a flaky gateway can trigger six.',
          timestamp: ago(now, 8),
        },
        {
          role: 'assistant',
          text: 'Added a retry budget of 3 per attempt in retryBudget.ts and threaded it through '
            + 'the gateway client. Want the budget configurable per merchant?',
          timestamp: ago(now, 2),
        },
      ],
    },
  };
}

/** The sort menu's items — mirrors SESSION_SORT_MODES, which the host sends with every update. */
export const sortModes = [
  { id: 'recent', label: 'Recently updated',
    description: 'Newest activity first. Rows move as sessions update.', stable: false },
  { id: 'hostWorkspace', label: 'Machine, then workspace',
    description: 'Groups by machine, then workspace, then title. Rows hold still.', stable: true },
  { id: 'workspace', label: 'Workspace, then title',
    description: 'Groups by workspace regardless of machine. Rows hold still.', stable: true },
  { id: 'source', label: 'Agent, then workspace',
    description: 'Groups Claude, Bob, Codex and Chat together. Rows hold still.', stable: true },
  { id: 'title', label: 'Title (A to Z)',
    description: 'Alphabetical by session title. Rows hold still.', stable: true },
  { id: 'status', label: 'Needs you first',
    description: 'Waiting, then running, then idle — newest first inside each group.', stable: false },
];
