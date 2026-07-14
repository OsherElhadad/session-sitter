import * as vscode from 'vscode';
import * as inspector from 'inspector';

export interface AutoRespondRule {
  matchPattern: string;
  response: string;
  source?: 'bob';
}

export interface BobSender {
  /** Send `text` as a user message into the existing Bob task `taskId`. */
  send(taskId: string, text: string): Promise<void>;
  /** Cheap capability probe: can we reach Bob's API at all? */
  isAvailable(): Promise<boolean>;
}

/** Pure helper: given probe results for each closure variable, pick the first
 *  variable whose object looks like Bob's TaskManager. Isolated for testing. */
export function pickClosureTaskManager(
  scopeVarProbes: Array<{ name: string; isTaskManager: boolean }>,
): string | undefined {
  return scopeVarProbes.find(p => p.isTaskManager)?.name;
}

const TASK_MANAGER_PROBE =
  'function(){return typeof this.openTask==="function" && typeof this.getChatManagerByTaskId==="function";}';
const SEND_FN =
  'function(taskId, text){ return Promise.resolve(this.openTask({taskId})).then(m => m.handleInputMessage({type:"userMessage", content:text, mode:"agent", meta:{mask:text}})); }';

export class InspectorBobSender implements BobSender {
  constructor(private readonly log: (msg: string) => void) {}

  async isAvailable(): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bobExt = vscode.extensions.getExtension<any>('IBM.bob-code');
    if (!bobExt) { return false; }
    const api = bobExt.isActive ? bobExt.exports : await Promise.resolve(bobExt.activate()).catch(() => undefined);
    return typeof api?.startTask === 'function';
  }

  async send(taskId: string, text: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bobExt = vscode.extensions.getExtension<any>('IBM.bob-code');
    if (!bobExt) { this.log('send skipped: IBM.bob-code not found'); return; }
    const api = bobExt.isActive ? bobExt.exports : await bobExt.activate();
    if (typeof api?.startTask !== 'function') { this.log('send skipped: no api.startTask'); return; }

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
      if (!fnId) { this.log('send failed: no objectId for api.startTask'); return; }

      const fnProps = await post('Runtime.getProperties', { objectId: fnId, ownProperties: false, generatePreview: false });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const scopesEntry = (fnProps.internalProperties || []).find((p: any) => p.name === '[[Scopes]]');
      if (!scopesEntry?.value?.objectId) { this.log('send failed: no [[Scopes]]'); return; }

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
        const sendRes = await post('Runtime.callFunctionOn', {
          objectId: nh.objectId, functionDeclaration: SEND_FN,
          arguments: [{ value: taskId }, { value: text }], awaitPromise: true, returnByValue: false,
        });
        if (sendRes.exceptionDetails) { this.log('send threw: ' + JSON.stringify(sendRes.exceptionDetails)); return; }
        this.log(`sent to task ${taskId}`);
        return;
      }
      this.log('send failed: TaskManager not found in any closure scope');
    } catch (err) {
      this.log('send error: ' + String(err));
    } finally {
      session.disconnect();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).__csw_bobApi;
    }
  }
}
