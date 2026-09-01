/**
 * Hook process plumbing: read the JSON event on stdin, write the JSON decision on stdout, exit 0.
 *
 * Every hook in this directory is the same shape — a testable `handle(input)` and a thin wrapper
 * that runs it as a process — so the wrapper lives here once.
 *
 * Two contract facts drive the design, both from the hooks reference:
 *
 *  - **Exit 2 is not honoured for `PermissionRequest`.** Only the `decision` object decides. So a
 *    hook must always print valid JSON, and a crash must not become an accidental silence.
 *  - **Exit 1 is a non-blocking error**: the action proceeds. Which means a thrown exception in a
 *    governance hook fails *open* unless the hook catches it and prints a decision itself. Hence
 *    `fallback`: the caller supplies the output to print when `handle` throws, and for
 *    `PermissionRequest` that fallback is a deny.
 */

/** Read all of stdin. Resolves to the empty string when nothing is piped in. */
export function readStdin(stream: NodeJS.ReadStream = process.stdin): Promise<string> {
  return new Promise(resolve => {
    let text = '';
    // A hook is always given stdin, but a hand-run `node hooks/x.js` with a tty is not, and it
    // must not hang forever waiting for a line nobody will type.
    if (stream.isTTY) { resolve(''); return; }
    stream.setEncoding('utf8');
    stream.on('data', chunk => { text += chunk; });
    stream.on('end', () => resolve(text));
    stream.on('error', () => resolve(text));
  });
}

/** The fields every hook event carries, plus whatever the specific event adds. */
export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  hook_event_name?: string;
  [key: string]: unknown;
}

/** Parse the event JSON. A malformed or empty payload becomes an empty event, never a throw. */
export function parseInput(text: string): HookInput {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as HookInput) : {};
  } catch {
    return {};
  }
}

export interface RunHookOptions {
  /** What to print when `handle` throws. Omit for a hook whose output is side-effect-only. */
  fallback?: (input: HookInput, error: unknown) => unknown;
}

/**
 * Run a hook as a process. Always writes valid JSON and always exits 0 — a non-zero exit from a
 * governance hook is either ignored (`PermissionRequest`) or read as a non-blocking error, and
 * neither is a decision.
 */
export async function runHook(
  handle: (input: HookInput) => Promise<unknown>,
  opts: RunHookOptions = {},
): Promise<void> {
  const input = parseInput(await readStdin());
  let output: unknown;
  try {
    output = await handle(input);
  } catch (err) {
    output = opts.fallback ? opts.fallback(input, err) : {};
  }
  process.stdout.write(`${JSON.stringify(output ?? {})}\n`);
  process.exit(0);
}
