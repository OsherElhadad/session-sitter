import { execFile } from 'child_process';

/**
 * The one place this extension reads IBM Bob's SQLite store (`~/.bob/db/bob.db`).
 *
 * ## Why a `python3` shim
 *
 * Bob keeps its tasks and messages in SQLite, and a VS Code extension has no SQLite driver
 * available: a native module (`sqlite3`, `better-sqlite3`) breaks VSIX portability across the
 * platforms and Electron ABIs the extension runs on, and `node:sqlite` is too new to rely on in
 * the VS Code / Bob IDE hosts this targets. Shelling out to `python3 -c` with the standard
 * library's `sqlite3` module needs no dependency at all and is read-only.
 *
 * This is the **only** external runtime dependency the extension has, and the only place any
 * Python is executed. Everything else — including the whole supervision runtime — is TypeScript.
 * Swapping in a WASM SQLite build later means replacing this one function.
 *
 * All queries are parameterized: the SQL is a constant in the caller and every value is passed
 * as an argv parameter, so no caller-supplied value is ever interpolated into SQL.
 */

/** Run python3 with the given args and return stdout. Rejects on a non-zero exit. */
export function execPython3(args: string[], maxBuffer = 32 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('python3', args, { maxBuffer }, (err, stdout, stderr) => {
      if (err) { reject(new Error(stderr || String(err))); return; }
      resolve(stdout);
    });
  });
}

// Reads the DB in read-only mode (`mode=ro`) so a query can never modify Bob's store, and emits
// rows as JSON objects keyed by column name.
const QUERY_SCRIPT = `
import json, sqlite3, sys
db, sql = sys.argv[1], sys.argv[2]
params = sys.argv[3:]
conn = sqlite3.connect("file:%s?mode=ro" % db, uri=True)
conn.row_factory = sqlite3.Row
try:
    rows = conn.execute(sql, params).fetchall()
    print(json.dumps([{k: r[k] for k in r.keys()} for r in rows]))
finally:
    conn.close()
`;

/**
 * Run one read-only, parameterized query against a SQLite database and return the rows.
 *
 * @param dbPath  absolute path to the SQLite file
 * @param sql     the statement, with `?` placeholders (a constant at every call site)
 * @param params  values bound to the placeholders
 */
export async function queryBobDb<T = Record<string, unknown>>(
  dbPath: string, sql: string, params: Array<string | number> = [],
): Promise<T[]> {
  const out = await execPython3(
    ['-c', QUERY_SCRIPT, dbPath, sql, ...params.map(p => String(p))]);
  const parsed = JSON.parse(out) as unknown;
  return Array.isArray(parsed) ? parsed as T[] : [];
}
