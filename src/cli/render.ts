/**
 * Plain ANSI output — no TUI framework, for the same reason the rest of this repo has no runtime
 * dependencies: a worklist is columns of text, and a dependency that draws columns of text is a
 * dependency you carry into every install.
 *
 * Two rules hold everywhere in here:
 *
 *  - **Colour is a property of the destination, not of the program.** A pipe gets no escapes, and
 *    `NO_COLOR` is honoured (https://no-color.org). A CLI that paints into a pipe corrupts the
 *    data of whatever reads it, which is worse than being plain.
 *  - **Nothing is invented.** A field that was not recorded prints `not recorded`, never a zero.
 *    These reports get screenshotted and forwarded; a fabricated number in one is a lie with a
 *    long half-life.
 */

/** Everything a command touches outside itself, so a test can drive it without a terminal. */
export interface Io {
  out(text: string): void;
  err(text: string): void;
  /** Whether stdout is a terminal — decides colour, and whether `--watch` can redraw. */
  isTty: boolean;
  /** Terminal width, when stdout is a terminal. */
  columns: number;
  env: Readonly<Record<string, string | undefined>>;
  now(): Date;
}

/** The real terminal. Kept here so `index.ts` has nothing to configure. */
export function processIo(): Io {
  return {
    out: text => process.stdout.write(text),
    err: text => process.stderr.write(text),
    isTty: process.stdout.isTTY === true,
    columns: process.stdout.columns ?? 100,
    env: process.env,
    now: () => new Date(),
  };
}

/**
 * Should this run emit colour?
 *
 * `NO_COLOR` set to anything at all — including the empty string — turns colour off; that is what
 * the convention says, and honouring only `NO_COLOR=1` is the usual way to get it wrong.
 * `TERM=dumb` is a terminal telling us it cannot render escapes.
 */
export function colorEnabled(io: Pick<Io, 'isTty' | 'env'>): boolean {
  if (io.env.NO_COLOR !== undefined) { return false; }
  if (io.env.FORCE_COLOR !== undefined && io.env.FORCE_COLOR !== '0') { return true; }
  if (!io.isTty) { return false; }
  return io.env.TERM !== 'dumb';
}

export const COLORS = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  magenta: '\u001b[35m',
  cyan: '\u001b[36m',
  gray: '\u001b[90m',
} as const;

export type ColorName = keyof typeof COLORS;

/** A painter that either paints or does not, decided once per run rather than at each call site. */
export type Paint = (text: string, color: ColorName) => string;

export function painter(enabled: boolean): Paint {
  if (!enabled) { return text => text; }
  return (text, color) => `${COLORS[color]}${text}${COLORS.reset}`;
}

/** Visible width: the escapes a painted string carries occupy no columns. */
export function visibleWidth(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '').length;
}

/** Pad to `width` counting only visible characters, so a painted cell still lines up. */
export function padVisible(text: string, width: number): string {
  const pad = width - visibleWidth(text);
  return pad > 0 ? text + ' '.repeat(pad) : text;
}

/**
 * Truncate to `width`, marking the cut with `…`.
 *
 * Only ever applied to free text (titles, clauses). Ids and paths are the fields people copy, so
 * they are never truncated — a column that silently shortens an id hands out ids that do not work.
 */
export function truncate(text: string, width: number): string {
  if (width <= 0) { return ''; }
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

export interface Column {
  header: string;
  /** Hard cap on width; the column still shrinks to its content. */
  max?: number;
  /** Right-align, for numbers and ages. */
  right?: boolean;
}

/**
 * Render aligned rows, sized to the content.
 *
 * Fixed widths would be simpler and would be wrong: a workspace column wide enough for the longest
 * real path wastes half the terminal on the common case, and one narrow enough for the common case
 * truncates the row you were looking for.
 */
export function table(columns: readonly Column[], rows: readonly string[][], paint: Paint): string {
  const cells = rows.map(row => row.map((cell, i) => {
    const max = columns[i]?.max;
    return max !== undefined ? truncate(cell, max) : cell;
  }));

  const widths = columns.map((col, i) => Math.max(
    visibleWidth(col.header),
    ...cells.map(row => visibleWidth(row[i] ?? '')),
  ));

  const line = (row: readonly string[], transform: (s: string) => string): string =>
    row
      .map((cell, i) => {
        const width = widths[i];
        const padded = columns[i]?.right
          ? ' '.repeat(Math.max(0, width - visibleWidth(cell))) + cell
          : padVisible(cell, width);
        return transform(padded);
      })
      .join('  ')
      .replace(/\s+$/, ''); // never emit trailing whitespace — it shows up in every diff and paste

  const out = [line(columns.map(c => c.header), s => paint(s, 'dim'))];
  for (const row of cells) { out.push(line(row, s => s)); }
  return out.join('\n');
}

// ── Watch-mode screen control ───────────────────────────────────────────────

/**
 * Clear the screen and put the cursor home.
 *
 * `2J` alone leaves the redrawn frame appended below the last one in terminals that keep the
 * scrollback in view, which is how a watch loop scrolls a terminal into oblivion. `3J` drops the
 * scrollback too, so each frame replaces the previous one in place.
 */
export const CLEAR_SCREEN = '\u001b[H\u001b[2J\u001b[3J';
export const HIDE_CURSOR = '\u001b[?25l';
export const SHOW_CURSOR = '\u001b[?25h';
