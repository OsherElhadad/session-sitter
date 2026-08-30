import * as vscode from 'vscode';
import * as inspector from 'inspector';

/** Pure helper: given probe results for each closure variable, pick the first
 *  variable whose object looks like Bob's TaskManager. Isolated for testing. */
export function pickClosureTaskManager(
  scopeVarProbes: Array<{ name: string; isTaskManager: boolean }>,
): string | undefined {
  return scopeVarProbes.find(p => p.isTaskManager)?.name;
}

// Serializes ALL inspector access. There is one shared inspector surface in the ext-host,
// and `callOnBobTaskManager` stashes `globalThis.__csw_bobApi` and deletes it in
// its `finally`. Several features now drive it on independent timers (auto-reply send, the
// approval sweep, and the supervision outbox — all every ~5s), so overlapping calls could
// let one call's cleanup yank the shared global mid-flight of another → intermittent silent
// no-ops. Chaining every call through a single promise guarantees one-at-a-time execution.
let inspectorChain: Promise<unknown> = Promise.resolve();

/** Run `fn` after all previously-queued inspector work settles (success OR failure), so
 *  inspector access never overlaps. A rejecting run never wedges the queue. Testable. */
export function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = inspectorChain.then(fn, fn);
  inspectorChain = run.then(() => undefined, () => undefined);
  return run;
}

const TASK_MANAGER_PROBE =
  'function(){return typeof this.openTask==="function" && typeof this.getChatManagerByTaskId==="function";}';

// Injected into Bob's ext-host with `this` = the TaskManager. Collects the task
// ids Bob currently has open in THIS window — the union of every loaded chat
// manager's tasks (`_chatManagers[].currentTasks[].getId()`, the same field the
// approver enumerates) and the top-level focused task
// (`getTopLevelChatManager().getTaskId()`). Returns them as a JSON string array.
const OPEN_TASK_IDS_FN = `function(){
  const ids = [];
  try {
    const mgrs = this._chatManagers || [];
    for (const m of mgrs) {
      try {
        const cur = m.currentTasks || [];
        for (const t of cur) { const id = t && t.getId && t.getId(); if (id) ids.push(id); }
      } catch (e) {}
    }
  } catch (e) {}
  try {
    const top = this.getTopLevelChatManager && this.getTopLevelChatManager();
    const tid = top && top.getTaskId && top.getTaskId();
    if (tid) ids.push(tid);
  } catch (e) {}
  return JSON.stringify(ids);
}`;

/** Parse the JSON string returned by OPEN_TASK_IDS_FN into a deduped string[].
 *  Returns [] for any non-string / malformed / non-array input. Pure — isolated
 *  for testing so the inspector round-trip doesn't need to run. */
export function parseOpenTaskIds(raw: unknown): string[] {
  if (typeof raw !== 'string') { return []; }
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) { return []; }
    return [...new Set(arr.filter((x): x is string => typeof x === 'string' && x.length > 0))];
  } catch {
    return [];
  }
}

/**
 * Ask Bob's live TaskManager which task ids are currently open in this window.
 * This is Bob's own notion of "open sessions" — not a heuristic — reachable only
 * in-process via the inspector. Returns [] on any failure (Bob missing, closure
 * not found, thrown call), so callers degrade to "no Bob active sessions".
 */
export async function getOpenBobTaskIds(log: (msg: string) => void): Promise<string[]> {
  const raw = await callOnBobTaskManager(log, OPEN_TASK_IDS_FN, [], false);
  const ids = parseOpenTaskIds(raw);
  log(`bob open task ids: ${ids.length} [${ids.join(', ')}]`);
  return ids;
}

/**
 * Reach IBM Bob's private module-local `TaskManager` instance (`Nh`) via the
 * in-process V8 inspector and invoke `functionDeclaration` on it, with `this`
 * bound to the TaskManager and `args` passed by value.
 *
 * The TaskManager is not exported; it is only reachable as a closure variable of
 * Bob's exported API methods. We walk `startTask`'s `[[Scopes]]` to find it
 * (proven in the auto-respond + auto-approve spikes).
 *
 * Returns the call's `returnByValue` result, or `undefined` on any failure
 * (missing extension, closure not found, thrown call). Never throws — logs and
 * no-ops, so callers in a scan loop stay safe.
 *
 * All access is serialized through {@link runExclusive} so concurrent callers (auto-reply,
 * approval sweep, supervision outbox) never overlap on the shared inspector surface.
 */
export function callOnBobTaskManager(
  log: (msg: string) => void,
  functionDeclaration: string,
  args: unknown[],
  awaitPromise = false,
): Promise<unknown> {
  return runExclusive(() => callOnBobTaskManagerUnsafe(log, functionDeclaration, args, awaitPromise));
}

async function callOnBobTaskManagerUnsafe(
  log: (msg: string) => void,
  functionDeclaration: string,
  args: unknown[],
  awaitPromise = false,
): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bobExt = vscode.extensions.getExtension<any>('IBM.bob-code');
  if (!bobExt) { log('bob inspector: IBM.bob-code not found'); return undefined; }
  const api = bobExt.isActive ? bobExt.exports : await bobExt.activate();
  if (typeof api?.startTask !== 'function') { log('bob inspector: no api.startTask'); return undefined; }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__csw_bobApi = api;
  const session = new inspector.Session();
  session.connect();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const post = (method: string, params?: any): Promise<any> =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new Promise((res, rej) => session.post(method as any, params, (e: any, r: any) => e ? rej(e) : res(r)));

  try {
    await post('Runtime.enable');
    const fn = await post('Runtime.evaluate', { expression: 'globalThis.__csw_bobApi.startTask', returnByValue: false });
    const fnId = fn.result?.objectId;
    if (!fnId) { log('bob inspector: no objectId for api.startTask'); return undefined; }

    const fnProps = await post('Runtime.getProperties', { objectId: fnId, ownProperties: false, generatePreview: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scopesEntry = (fnProps.internalProperties || []).find((p: any) => p.name === '[[Scopes]]');
    if (!scopesEntry?.value?.objectId) { log('bob inspector: no [[Scopes]]'); return undefined; }

    const scopes = await post('Runtime.getProperties', { objectId: scopesEntry.value.objectId, ownProperties: false });
    for (const scope of scopes.result || []) {
      if (!scope.value?.objectId) { continue; }
      const vars = await post('Runtime.getProperties', { objectId: scope.value.objectId, ownProperties: true });
      const probes: Array<{ name: string; isTaskManager: boolean; objectId: string }> = [];
      for (const v of vars.result || []) {
        if (!v.value?.objectId) { continue; }
        const probe = await post('Runtime.callFunctionOn', {
          objectId: v.value.objectId, functionDeclaration: TASK_MANAGER_PROBE, returnByValue: true,
        });
        probes.push({ name: v.name, isTaskManager: probe.result?.value === true, objectId: v.value.objectId });
      }
      const pick = pickClosureTaskManager(probes.map(p => ({ name: p.name, isTaskManager: p.isTaskManager })));
      if (!pick) { continue; }
      const nh = probes.find(p => p.name === pick)!;
      const res = await post('Runtime.callFunctionOn', {
        objectId: nh.objectId, functionDeclaration,
        arguments: args.map(a => ({ value: a })), awaitPromise, returnByValue: true,
      });
      if (res.exceptionDetails) { log('bob inspector: call threw: ' + JSON.stringify(res.exceptionDetails)); return undefined; }
      return res.result?.value;
    }
    log('bob inspector: TaskManager not found in any closure scope');
    return undefined;
  } catch (err) {
    log('bob inspector: error ' + String(err));
    return undefined;
  } finally {
    session.disconnect();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).__csw_bobApi;
  }
}
