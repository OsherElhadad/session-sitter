import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The shipped plugin tree, tested as a user gets it.
 *
 * `plugin/lib/` is committed build output, and `ci/check-plugin-lib.sh` already proves it is the
 * *current* build of `src/`. What that guard cannot tell you is whether the tree **runs**: it diffs
 * bytes, so a missing module is invisible to it and shows up for the first time as a stack trace in
 * front of a user at a permission prompt. These tests spawn the shipped files.
 *
 * They assert against `plugin/`, not `out/`, on purpose. Everything else in this suite tests the
 * TypeScript; this file tests the artifact.
 */

const repoRoot = path.resolve(__dirname, '..', '..');
const pluginDir = path.join(repoRoot, 'plugin');
const libDir = path.join(pluginDir, 'lib');

/** Run a shipped entry point in a bare Node process, as Claude Code would. */
function runNode(relPath: string, args: readonly string[] = []): string {
  return execFileSync(process.execPath, [path.join(libDir, relPath), ...args], {
    encoding: 'utf8',
    // A hermetic data dir: these must not read, and certainly not write, the developer's own trail.
    env: {
      ...process.env,
      SESSION_SITTER_DATA_DIR: path.join(repoRoot, 'out', '.test-plugin-tree-data'),
    },
  });
}

describe('the shipped CLI', () => {
  it('ships at all — the whole point of putting it in the plugin', () => {
    expect(fs.existsSync(path.join(libDir, 'cli', 'index.js'))).toBe(true);
  });

  /**
   * The test that earns its place: a bare `node` on the shipped file. A module missing from the
   * closure fails here, in CI, rather than in front of someone running a slash command.
   */
  it('runs standalone, with every module it requires present in the tree', () => {
    expect(runNode('cli/index.js', ['--version'])).toMatch(/^session-sitter \d+\.\d+\.\d+/);
  });

  it('lists every command, so a slash command cannot point at a subcommand that is gone', () => {
    const help = runNode('cli/index.js', ['--help']);
    for (const command of ['status', 'log', 'digest', 'policy', 'learn', 'export']) {
      expect(help).toContain(command);
    }
  });

  /**
   * A plugin is a git ref cloned into place, not a build, so it has no build time — and
   * `scripts/build-plugin-lib.js` empties the field rather than baking in the moment some maintainer
   * ran `make plugin`. That emptying is also what keeps the rebuild reproducible, which is what
   * `ci/check-plugin-lib.sh` depends on: a wall-clock timestamp in a committed tree makes that guard
   * fail on every CI run, because CI compiles before it checks.
   */
  it('reports a version with no build time, so the committed tree is reproducible', () => {
    const version = runNode('cli/index.js', ['--version']).trim();
    expect(version).not.toContain('built');
    expect(version).not.toContain('(');
    expect(fs.readFileSync(path.join(libDir, 'buildInfo.js'), 'utf8'))
      .toContain("BUILD_TIME = ''");
  });

  it('reports the version the plugin manifest claims, so the two cannot disagree', () => {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8')) as { version: string };
    expect(runNode('cli/index.js', ['--version']).trim())
      .toBe(`session-sitter ${manifest.version}`);
  });
});

describe('the shipped launcher', () => {
  const launcher = path.join(pluginDir, 'bin', 'session-sitter');

  it('exists and is executable — it is the file you symlink onto PATH', () => {
    expect(fs.existsSync(launcher)).toBe(true);
    // Committed mode bits: a launcher that arrives non-executable is a launcher nobody can run, and
    // git does record the x bit.
    expect(fs.statSync(launcher).mode & 0o111).not.toBe(0);
  });

  it('runs the CLI, and keeps the CLI exit code rather than a shell of its own', () => {
    expect(execFileSync(launcher, ['--version'], { encoding: 'utf8' }))
      .toMatch(/^session-sitter \d+\.\d+\.\d+/);
    // Exit 2 is the CLI's "bad arguments". `exec` in the launcher is what preserves it.
    let code: number | undefined;
    try {
      execFileSync(launcher, ['no-such-command'], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      code = (err as { status?: number }).status;
    }
    expect(code).toBe(2);
  });

  it('resolves its own symlinks, because that is how it reaches PATH', () => {
    const link = path.join(repoRoot, 'out', 'test-launcher-symlink');
    fs.rmSync(link, { force: true });
    fs.symlinkSync(launcher, link);
    try {
      expect(execFileSync(link, ['--version'], { encoding: 'utf8' }))
        .toMatch(/^session-sitter /);
    } finally {
      fs.rmSync(link, { force: true });
    }
  });
});

/**
 * Every `!`-substituted script a slash command runs has to be in the shipped tree.
 *
 * This is the failure this file exists for, in its most likely form: a command file naming a script
 * that `build-plugin-lib.js` was never told to ship. Nothing else catches it — the manifest validates,
 * `plugin/lib` diffs clean, the tests pass, and the command fails the first time a user types it.
 */
describe('the slash commands', () => {
  const commandsDir = path.join(pluginDir, 'commands');
  const commandFiles = fs.readdirSync(commandsDir).filter(f => f.endsWith('.md'));

  it('are all present', () => {
    expect(commandFiles.length).toBeGreaterThan(0);
  });

  it.each(commandFiles)('%s runs only scripts that exist in plugin/lib', file => {
    const text = fs.readFileSync(path.join(commandsDir, file), 'utf8');
    const referenced = [...text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9_./-]+\.js)/g)]
      .map(m => m[1]);
    // A command that shells out to nothing is fine; one that names a missing file is not.
    for (const rel of new Set(referenced)) {
      expect(fs.existsSync(path.join(pluginDir, rel)), `${file} references ${rel}`).toBe(true);
    }
  });

  it.each(commandFiles)('%s declares every script it runs in allowed-tools', file => {
    const text = fs.readFileSync(path.join(commandsDir, file), 'utf8');
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text);
    expect(frontmatter, `${file} has no frontmatter`).not.toBeNull();
    const allowed = /^allowed-tools:.*$/m.exec(frontmatter![1])?.[0] ?? '';
    for (const rel of new Set(
      [...text.slice(frontmatter![0].length)
        .matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9_./-]+\.js)/g)].map(m => m[1]),
    )) {
      // Otherwise the command prompts for permission every time, which for a governance tool is
      // both ironic and enough to stop people using it.
      expect(allowed, `${file} runs ${rel} without declaring it`).toContain(rel);
    }
  });
});
