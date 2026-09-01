import { describe, it, expect } from 'vitest';
import { applyCorrection } from '../../policy/corrections';

const bash = (command: string) => applyCorrection('Bash', { command, description: 'x' });

describe('applyCorrection — force push', () => {
  it('rewrites --force to --force-with-lease', () => {
    const c = bash('git push --force origin main');
    expect(c?.updatedInput.command).toBe('git push --force-with-lease origin main');
    expect(c?.ruleId).toBe('force-push-to-lease');
    expect(c?.clauseId).toBe('force-push');
    expect(c?.note).toContain('--force-with-lease');
  });

  it('rewrites a bare -f', () => {
    expect(bash('git push -f origin main')?.updatedInput.command)
      .toBe('git push --force-with-lease origin main');
  });

  it('keeps the other short flags in a cluster', () => {
    expect(bash('git push -fu origin main')?.updatedInput.command)
      .toBe('git push -u --force-with-lease origin main');
  });

  it('leaves an already-safe push alone', () => {
    expect(bash('git push --force-with-lease origin main')).toBeNull();
  });

  it('leaves a plain push alone', () => {
    expect(bash('git push origin main')).toBeNull();
  });

  it('does not read a filename as a short flag cluster', () => {
    // `-final` contains an `f`; treating it as `-f` would rewrite an unrelated argument.
    expect(bash('git push origin -final')).toBeNull();
  });

  it('preserves the rest of the tool input', () => {
    const c = applyCorrection('Bash', { command: 'git push -f', description: 'ship it', timeout: 5 });
    expect(c?.updatedInput).toMatchObject({ description: 'ship it', timeout: 5 });
  });

  it('ignores a force flag that is not a git push', () => {
    expect(bash('rsync --force a b')).toBeNull();
  });
});

describe('applyCorrection — chmod', () => {
  it('rewrites 777 to 755', () => {
    expect(bash('chmod 777 ./run.sh')?.updatedInput.command).toBe('chmod 755 ./run.sh');
  });

  it('rewrites the four-digit form', () => {
    expect(bash('chmod 0777 ./run.sh')?.updatedInput.command).toBe('chmod 755 ./run.sh');
  });

  it('keeps the recursive flag', () => {
    expect(bash('chmod -R 777 ./dist')?.updatedInput.command).toBe('chmod -R 755 ./dist');
  });

  it('leaves other modes alone', () => {
    expect(bash('chmod 600 ~/.ssh/config')).toBeNull();
    expect(bash('chmod +x ./run.sh')).toBeNull();
  });
});

describe('applyCorrection — what it deliberately does not rewrite', () => {
  // Each of these is a rejected rule documented in corrections.ts. The test is here so removing
  // that reasoning also breaks a test rather than quietly shipping a guess.
  it('never rewrites a deletion', () => {
    expect(bash('rm -rf ./build')).toBeNull();
  });
  it('never rewrites a discard of uncommitted work', () => {
    expect(bash('git reset --hard HEAD~1')).toBeNull();
    expect(bash('git checkout .')).toBeNull();
  });
  it('never pins an unpinned dependency', () => {
    expect(bash('npm install left-pad')).toBeNull();
  });
});

describe('applyCorrection — inputs it must not touch', () => {
  it('ignores a tool that is not Bash', () => {
    expect(applyCorrection('Write', { command: 'git push --force' })).toBeNull();
  });
  it('ignores an input with no command', () => {
    expect(applyCorrection('Bash', { file_path: '/tmp/x' })).toBeNull();
  });
  it('ignores a missing input', () => {
    expect(applyCorrection('Bash', null)).toBeNull();
    expect(applyCorrection('Bash', undefined)).toBeNull();
  });
});
