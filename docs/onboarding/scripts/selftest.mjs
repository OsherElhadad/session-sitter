#!/usr/bin/env node
/**
 * Self-test for `ss-config.mjs`.
 *
 * The onboarding skill's whole promise is that an agent never has to remember a setting id or
 * guess what breaks a configuration: it runs the doctor and reports what the doctor found. That
 * promise is only as good as the doctor, so every check has a fixture here that must produce the
 * finding code, and every example configuration under `../examples/` must come back clean.
 *
 * Two failure modes this rules out, both of which would make the skill confidently wrong:
 *
 *   - a check that no longer fires. A refactor, or a schema change, quietly turning a validation
 *     into a no-op — the doctor then reports a broken configuration as healthy.
 *   - a shipped example that does not validate. The skill offers these as starting points, so an
 *     example carrying a typo would be pasted straight into a user's settings.
 *
 * Usage:  node selftest.mjs [--verbose]
 * Exit:   0 every case passed · 1 at least one failed
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCTOR = join(HERE, 'ss-config.mjs');
const EXAMPLES = join(HERE, '..', 'examples');
const VERBOSE = process.argv.includes('--verbose');

/**
 * Run `check --json` over one settings object in a throwaway directory.
 *
 * The temporary directory is also the workspace root, which matters: it has no `.env` beside it,
 * so a case's outcome depends on its fixture and never on the machine running the test. The
 * environment is likewise reduced to a fixed set, because `ANTHROPIC_BASE_URL` in a developer's
 * shell would otherwise silence the fast-classifier case.
 */
function check(settings, { kind = 'user', env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ss-selftest-'));
  try {
    const path = join(dir, 'settings.json');
    writeFileSync(path, typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2));
    return run(['check', '--json', '--settings', path, '--kind', kind, '--workspace-root', dir], env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(args, env = {}) {
  let stdout = '', status = 0;
  try {
    stdout = execFileSync(process.execPath, [DOCTOR, ...args], {
      encoding: 'utf8',
      // A bare environment: PATH and HOME are needed, everything else would leak the developer's
      // own configuration into an assertion.
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    });
  } catch (err) {
    stdout = err.stdout ?? '';
    status = err.status ?? 1;
  }
  return { status, report: JSON.parse(stdout) };
}

const codes = report => report.findings.map(f => f.code);

// ── Cases ───────────────────────────────────────────────────────────────────
//
// Each case names the finding code it must produce. `wants` is what has to appear; `forbids` is
// what must not — a positive assertion alone would pass a doctor that returned every code for
// every input.

const cases = [
  {
    name: 'an empty configuration is valid, and says the supervisor is off',
    settings: {},
    wants: ['nothing-configured', 'supervisor-off'],
    exit: 0,
  },
  {
    name: 'a misspelled setting is an error, with the correction named',
    settings: { 'sessionSitter.sessionSorting': 'recent' },
    wants: ['unknown-key'],
    exit: 1,
    then: report => {
      const finding = report.findings.find(f => f.code === 'unknown-key');
      assert(finding.message.includes('sessionSitter.sessionSort'),
        `expected the suggestion to name sessionSitter.sessionSort, got: ${finding.message}`);
    },
  },
  {
    name: 'a removed setting is a warning naming its replacement',
    settings: { 'sessionSitter.uploadScriptPath': '/tmp/upload.sh' },
    wants: ['removed-key'],
    forbids: ['unknown-key'],
    exit: 0,
  },
  {
    name: 'the wrong JSON type is an error',
    settings: { 'sessionSitter.autoSupervise': 'true' },
    wants: ['wrong-type'],
    exit: 1,
  },
  {
    name: 'a value outside an enum is an error',
    settings: { 'sessionSitter.sessionSort': 'alphabetical' },
    wants: ['bad-enum'],
    exit: 1,
  },
  {
    name: 'a number past its declared maximum is an error',
    settings: { 'sessionSitter.telegram.maxMessageParts': 50 },
    wants: ['out-of-range'],
    exit: 1,
  },
  {
    name: 'a number below its declared minimum is an error',
    settings: { 'sessionSitter.supervisor.classifierTimeoutSeconds': 5 },
    wants: ['out-of-range'],
    exit: 1,
  },
  {
    name: 'unparsable settings are an error, and nothing else is claimed about the file',
    settings: '{ "sessionSitter.autoSupervise": true,,, }',
    wants: ['settings-unparsable'],
    exit: 1,
  },
  {
    name: 'comments and a trailing comma parse, the way VS Code accepts them',
    settings: '{\n  // the panel needs no configuration\n  "sessionSitter.sessionSort": "title",\n}',
    wants: [],
    forbids: ['settings-unparsable', 'unknown-key', 'bad-enum'],
    exit: 0,
  },
  {
    name: 'a credential in workspace settings is an error',
    settings: { 'sessionSitter.supervisor.telegramBotToken': '123456:ABC' },
    kind: 'workspace',
    wants: ['credential-in-workspace'],
    exit: 1,
  },
  {
    name: 'the same credential in user settings is fine',
    settings: { 'sessionSitter.supervisor.telegramBotToken': '123456:ABC' },
    kind: 'user',
    forbids: ['credential-in-workspace'],
    exit: 0,
  },
  {
    name: 'a colour that is not a colour is a warning',
    settings: { 'sessionSitter.workspaceColors': { 'my-app': 'chartreuse' } },
    wants: ['bad-colour'],
    exit: 0,
  },
  {
    name: 'every documented colour form is accepted',
    settings: {
      'sessionSitter.workspaceColors': {
        'by-name': 'teal', 'by-hex-short': '#0f8', 'by-hex-long': '#1a2b3c',
        'derived': 'auto', 'GLOB-*': 'slate', '*': 'auto',
      },
    },
    forbids: ['bad-colour'],
    exit: 0,
  },
  {
    name: 'a text rule missing its response never fires, and is an error',
    settings: { 'sessionSitter.autoRespond': [{ matchPattern: 'continue\\?' }] },
    wants: ['rule-shape'],
    exit: 1,
  },
  {
    name: 'an approval rule missing its decision never fires, and is an error',
    settings: { 'sessionSitter.autoRespond': [{ toolPattern: 'read_file' }] },
    wants: ['rule-shape'],
    exit: 1,
  },
  {
    name: 'an unknown decision is an error',
    settings: { 'sessionSitter.autoRespond': [{ toolPattern: '*', decision: 'approve' }] },
    wants: ['rule-shape'],
    exit: 1,
  },
  {
    name: 'an invalid regex is an error, because the rule is skipped rather than throwing',
    settings: { 'sessionSitter.autoRespond': [{ matchPattern: '([unclosed', response: 'yes' }] },
    wants: ['rule-bad-regex'],
    exit: 1,
  },
  {
    name: 'a Claude approval rule with a sessionPattern is an error — it is silently skipped',
    settings: {
      'sessionSitter.autoRespond': [
        { source: 'claude', toolPattern: 'Read', decision: 'approveOnce', sessionPattern: '/work/' },
      ],
    },
    wants: ['rule-claude-scoped'],
    exit: 1,
  },
  {
    name: 'the same rule for Bob is fine — sessionPattern is honoured there',
    settings: {
      'sessionSitter.autoRespond': [
        { source: 'bob', toolPattern: 'read_file', decision: 'approveOnce', sessionPattern: '/work/' },
      ],
    },
    forbids: ['rule-claude-scoped'],
    exit: 0,
  },
  {
    name: 'a rule after a catch-all in the same lane is unreachable',
    settings: {
      'sessionSitter.autoRespond': [
        { toolPattern: '*', decision: 'approveOnce' },
        { toolPattern: 'execute_command', decision: 'reject' },
      ],
    },
    wants: ['rule-unreachable'],
    exit: 0,
  },
  {
    name: 'a catch-all in the Bob lane does not shadow a Claude rule',
    settings: {
      'sessionSitter.autoRespond': [
        { source: 'bob', toolPattern: '*', decision: 'approveForTask' },
        { source: 'claude', toolPattern: 'Read|Glob', decision: 'approveForTask' },
      ],
    },
    forbids: ['rule-unreachable'],
    exit: 0,
  },
  {
    name: 'a scoped catch-all does not shadow what follows it',
    settings: {
      'sessionSitter.autoRespond': [
        { toolPattern: '*', decision: 'approveOnce', sessionPattern: '/scratch/' },
        { toolPattern: 'execute_command', decision: 'reject' },
      ],
    },
    forbids: ['rule-unreachable'],
    exit: 0,
  },
  {
    name: 'a rule naming a question tool is reported as unable to take effect',
    settings: {
      'sessionSitter.autoRespond': [{ toolPattern: 'ask_followup_question', decision: 'approveOnce' }],
    },
    wants: ['rule-question-tool'],
    exit: 0,
  },
  {
    name: 'an unrecognised rule field is a warning',
    settings: {
      'sessionSitter.autoRespond': [{ toolPattern: 'Read', decision: 'approveOnce', timeout: 30 }],
    },
    wants: ['rule-unknown-field'],
    exit: 0,
  },
  {
    name: 'telegram selected with no token is an error, and says cards fall back to files',
    settings: { 'sessionSitter.supervisor.messagingChannel': 'telegram' },
    wants: ['telegram-incomplete'],
    exit: 1,
  },
  {
    name: 'a token from the environment satisfies the telegram channel',
    settings: {
      'sessionSitter.supervisor.messagingChannel': 'telegram',
      'sessionSitter.supervisor.telegramChatId': '-1001234567890',
    },
    env: { TELEGRAM_BOT_TOKEN: '123456:ABC' },
    forbids: ['telegram-incomplete'],
    exit: 0,
  },
  {
    name: 'remote control with an empty allowlist is an error',
    settings: {
      'sessionSitter.telegram.remoteControl': true,
      'sessionSitter.telegram.allowedUserIds': [],
    },
    env: { TELEGRAM_BOT_TOKEN: '123456:ABC', TELEGRAM_CHAT_ID: '-1001234567890' },
    wants: ['remote-control-no-allowlist'],
    exit: 1,
  },
  {
    name: 'remote control with no token at all is an error',
    settings: {
      'sessionSitter.telegram.remoteControl': true,
      'sessionSitter.telegram.allowedUserIds': ['123456789'],
    },
    wants: ['remote-control-no-token'],
    exit: 1,
  },
  {
    name: 'remote control turned on from the environment is resolved, allowlist and all',
    // `src/settingsBridge.ts` gave the four telegram.* settings environment equivalents, which
    // `src/extension.ts` layers under the explicit setting. A configuration with none of them in
    // settings is therefore not necessarily off, and a doctor that only read settings would report
    // this one as off while the extension had it on.
    settings: {},
    env: {
      SESSION_SITTER_TELEGRAM_REMOTE_CONTROL: '1',
      SESSION_SITTER_TELEGRAM_ALLOWED_USER_IDS: '123456789',
      TELEGRAM_BOT_TOKEN: '123456:ABC',
      TELEGRAM_CHAT_ID: '-1001234567890',
    },
    // The allowlist resolves from the environment, so neither remote-control error applies.
    forbids: ['remote-control-no-token', 'remote-control-no-allowlist'],
    exit: 0,
  },
  {
    name: 'remote control on from the environment with no allowlist anywhere is still an error',
    settings: {},
    env: {
      SESSION_SITTER_TELEGRAM_REMOTE_CONTROL: 'true',
      TELEGRAM_BOT_TOKEN: '123456:ABC',
      TELEGRAM_CHAT_ID: '-1001234567890',
    },
    wants: ['remote-control-no-allowlist'],
    exit: 1,
  },
  {
    name: 'a positive chat id is not a group, and Topics need one',
    settings: {
      'sessionSitter.telegram.remoteControl': true,
      'sessionSitter.telegram.allowedUserIds': ['123456789'],
      'sessionSitter.supervisor.telegramChatId': '123456789',
    },
    env: { TELEGRAM_BOT_TOKEN: '123456:ABC' },
    wants: ['chat-id-not-a-group'],
    // A warning, not an error: a positive id is almost certainly wrong, but the extension will
    // still start and say so in its log rather than refusing to run.
    exit: 0,
  },
  {
    name: 'a bot token in settings with remote control on warns about Settings Sync',
    settings: {
      'sessionSitter.telegram.remoteControl': true,
      'sessionSitter.telegram.allowedUserIds': ['123456789'],
      'sessionSitter.supervisor.telegramBotToken': '123456:ABC',
      'sessionSitter.supervisor.telegramChatId': '-1001234567890',
    },
    wants: ['token-in-settings'],
    exit: 0,
  },
  {
    name: 'a state directory that does not exist is a warning, not an error',
    settings: { 'sessionSitter.supervisorStateDir': '/nonexistent/session-sitter/state' },
    wants: ['state-dir-missing'],
    forbids: ['supervisor-off'],
    exit: 0,
  },
  {
    name: 'a data repo path that does not exist is an error',
    settings: { 'sessionSitter.dataRepoPath': '/nonexistent/corpus' },
    wants: ['path-missing'],
    exit: 1,
  },
  {
    name: 'knowledge slugs with no source cannot resolve a tier file',
    settings: {
      'sessionSitter.knowledge.user': 'alice',
      'sessionSitter.knowledge.team': 'platform',
    },
    wants: ['knowledge-no-source'],
    exit: 0,
  },
  {
    name: 'the fast classifier reports itself inert without a gateway, token and model',
    settings: {
      'sessionSitter.supervisorStateDir': '/nonexistent/state',
      'sessionSitter.supervisor.fastClassifier': true,
    },
    wants: ['fast-classifier-inert'],
    exit: 0,
  },
  {
    name: 'with a gateway, token and model it is not reported inert',
    settings: {
      'sessionSitter.supervisorStateDir': '/nonexistent/state',
      'sessionSitter.supervisor.fastClassifier': true,
      'sessionSitter.supervisor.anthropicBaseUrl': 'https://gateway.example/v1',
      'sessionSitter.supervisor.anthropicAuthToken': 'sk-test',
      'sessionSitter.supervisor.fastClassifierModel': 'claude-opus-5',
    },
    forbids: ['fast-classifier-inert'],
    exit: 0,
  },
  {
    name: 'autoSupervise off with a state dir set is reported',
    settings: {
      'sessionSitter.supervisorStateDir': '/nonexistent/state',
      'sessionSitter.autoSupervise': false,
    },
    wants: ['auto-supervise-off'],
    exit: 0,
  },
];

// ── Runner ──────────────────────────────────────────────────────────────────

let failures = 0;

function assert(condition, message) {
  if (!condition) { throw new Error(message); }
}

for (const testCase of cases) {
  try {
    const { status, report } = check(testCase.settings, { kind: testCase.kind, env: testCase.env });
    const found = codes(report);
    for (const want of testCase.wants ?? []) {
      assert(found.includes(want), `expected finding "${want}", got: ${found.join(', ') || '(none)'}`);
    }
    for (const forbid of testCase.forbids ?? []) {
      assert(!found.includes(forbid), `finding "${forbid}" should not have been reported`);
    }
    if (testCase.exit !== undefined) {
      assert(status === testCase.exit, `expected exit ${testCase.exit}, got ${status}`);
    }
    testCase.then?.(report);
    process.stdout.write(`  ok   ${testCase.name}\n`);
    if (VERBOSE && found.length) { process.stdout.write(`         ${found.join(', ')}\n`); }
  } catch (err) {
    failures++;
    process.stdout.write(`  FAIL ${testCase.name}\n         ${err.message}\n`);
  }
}

// Every shipped example must validate cleanly against the real schema. An example is offered to a
// user as something to paste, so a typo in one is a typo in their settings.
//
// Each example is validated with the environment its OWN COMMENTS tell the user to set — the
// credentials that deliberately do not live in settings. That is the point of the assertion: an
// example is complete when its settings plus its documented environment validate clean. If an
// example stops describing the environment it needs, this map stops matching and the case fails.
const EXAMPLE_ENV = {
  '04-telegram-cards.json': { TELEGRAM_BOT_TOKEN: '123456:ABC' },
  '05-telegram-remote-control.json': { TELEGRAM_BOT_TOKEN: '123456:ABC' },
  '06-fast-classifier-gateway.json': { ANTHROPIC_AUTH_TOKEN: 'sk-test' },
  '07-remote-and-wsl.json': { BOBSHELL_API_KEY: 'test-key' },
};

// Paths inside an example are illustrative, so the three "does not exist" findings are expected
// and are not a defect in the example itself.
const EXPECTED_IN_EXAMPLES = new Set(['path-missing', 'state-dir-missing', 'corpus-layout']);

process.stdout.write('\nExample configurations:\n');
for (const name of readdirSync(EXAMPLES).filter(f => f.endsWith('.json')).sort()) {
  const path = join(EXAMPLES, name);
  try {
    const { report } = run(['check', '--json', '--settings', path, '--kind', 'user',
      '--workspace-root', tmpdir()], EXAMPLE_ENV[name] ?? {});
    const real = report.findings.filter(f => f.level !== 'info' && !EXPECTED_IN_EXAMPLES.has(f.code));
    assert(real.length === 0,
      `unexpected finding(s): ${real.map(f => `${f.code}: ${f.message}`).join(' · ')}`);
    process.stdout.write(`  ok   ${name}\n`);
  } catch (err) {
    failures++;
    process.stdout.write(`  FAIL ${name}\n         ${err.message}\n`);
  }
}

process.stdout.write(failures
  ? `\n${failures} failure(s).\n`
  : `\n${cases.length} case(s) and every example passed.\n`);
process.exit(failures ? 1 : 0);
