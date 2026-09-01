import { describe, it, expect } from 'vitest';
import {
  COLORS, colorEnabled, padVisible, painter, table, truncate, visibleWidth,
} from '../../cli/render';
import { fakeIo } from './fakeIo';

describe('colorEnabled', () => {
  it('is off when stdout is not a terminal — a pipe must get data, not escapes', () => {
    expect(colorEnabled(fakeIo({ isTty: false }))).toBe(false);
  });

  it('is on for a terminal', () => {
    expect(colorEnabled(fakeIo({ isTty: true }))).toBe(true);
  });

  it('honours NO_COLOR set to ANYTHING, including the empty string', () => {
    // Honouring only NO_COLOR=1 is the usual way to get this convention wrong.
    expect(colorEnabled(fakeIo({ isTty: true, env: { NO_COLOR: '' } }))).toBe(false);
    expect(colorEnabled(fakeIo({ isTty: true, env: { NO_COLOR: '0' } }))).toBe(false);
    expect(colorEnabled(fakeIo({ isTty: true, env: { NO_COLOR: '1' } }))).toBe(false);
  });

  it('honours TERM=dumb', () => {
    expect(colorEnabled(fakeIo({ isTty: true, env: { TERM: 'dumb' } }))).toBe(false);
    expect(colorEnabled(fakeIo({ isTty: true, env: { TERM: 'xterm-256color' } }))).toBe(true);
  });

  it('lets FORCE_COLOR override a pipe, but not NO_COLOR', () => {
    expect(colorEnabled(fakeIo({ isTty: false, env: { FORCE_COLOR: '1' } }))).toBe(true);
    expect(colorEnabled(fakeIo({ isTty: false, env: { FORCE_COLOR: '0' } }))).toBe(false);
    expect(colorEnabled(fakeIo({ isTty: true, env: { FORCE_COLOR: '1', NO_COLOR: '1' } })))
      .toBe(false);
  });
});

describe('painter', () => {
  it('emits nothing at all when colour is off', () => {
    const plain = painter(false);
    expect(plain('needs you', 'yellow')).toBe('needs you');
  });

  it('wraps and resets when colour is on', () => {
    expect(painter(true)('needs you', 'yellow'))
      .toBe(`${COLORS.yellow}needs you${COLORS.reset}`);
  });
});

describe('visibleWidth', () => {
  it('ignores the escapes a painted string carries', () => {
    expect(visibleWidth(painter(true)('needs you', 'yellow'))).toBe(9);
    expect(visibleWidth('needs you')).toBe(9);
  });
});

describe('padVisible', () => {
  it('pads a painted cell to its visible width, not its byte length', () => {
    const painted = painter(true)('ok', 'green');
    expect(visibleWidth(padVisible(painted, 5))).toBe(5);
  });

  it('never truncates when the text is already too wide', () => {
    expect(padVisible('overlong', 3)).toBe('overlong');
  });
});

describe('truncate', () => {
  it('marks the cut', () => {
    expect(truncate('abcdefgh', 5)).toBe('abcd…');
    expect(truncate('abc', 5)).toBe('abc');
    expect(truncate('abc', 0)).toBe('');
  });
});

describe('table', () => {
  const columns = [{ header: 'TOOL' }, { header: 'AGE', right: true }];

  it('aligns on content width, with no trailing whitespace on any line', () => {
    const out = table(columns, [['Bash', '2h'], ['Read', '12m']], painter(false));
    expect(out.split('\n')).toEqual([
      'TOOL  AGE',
      'Bash   2h',
      'Read  12m',
    ]);
    for (const line of out.split('\n')) { expect(line).toBe(line.replace(/\s+$/, '')); }
  });

  it('lines up identically whether or not the cells are painted', () => {
    const plain = table(columns, [['Bash', '2h']], painter(false));
    const painted = table(
      columns, [[painter(true)('Bash', 'green'), '2h']], painter(true));
    // Strip every escape from the painted render; the columns must land in the same places.
    // eslint-disable-next-line no-control-regex
    expect(painted.replace(/\u001b\[[0-9;]*m/g, '')).toBe(plain);
  });

  it('applies a column max', () => {
    const out = table([{ header: 'T', max: 4 }], [['abcdefg']], painter(false));
    expect(out.split('\n')[1]).toBe('abc…');
  });

  it('renders a header even with no rows', () => {
    expect(table(columns, [], painter(false))).toBe('TOOL  AGE');
  });
});
