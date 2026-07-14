import * as vscode from 'vscode';
import * as inspector from 'inspector';

// Throwaway spike: extract Bob's private TaskManager (Nh) via the V8 inspector
// and send a message into an EXISTING task (by taskId). Verifies feasibility.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function spikeInspectorSend(taskId: string, text: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bobExt = vscode.extensions.getExtension<any>('IBM.bob-code');
  if (!bobExt) { return 'FAIL: IBM.bob-code not found'; }
  const api = bobExt.isActive ? bobExt.exports : await bobExt.activate();
  if (!api?.startTask) { return 'FAIL: no api.startTask'; }

  // Expose the api object so Runtime.evaluate can obtain an objectId for it.
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

    // 1. objectId of one of the api's closure-bearing methods.
    const fn = await post('Runtime.evaluate', {
      expression: 'globalThis.__csw_bobApi.startTask',
      returnByValue: false,
    });
    const fnId = fn.result?.objectId as string | undefined;
    if (!fnId) { return 'FAIL: no objectId for api.startTask'; }

    // 2. Function internals → [[Scopes]].
    const fnProps = await post('Runtime.getProperties', { objectId: fnId, ownProperties: false, generatePreview: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scopesEntry = (fnProps.internalProperties || []).find((p: any) => p.name === '[[Scopes]]');
    if (!scopesEntry?.value?.objectId) { return 'FAIL: no [[Scopes]] on startTask'; }

    // 3. Enumerate scopes; for each Closure scope, look for a var that is the TaskManager.
    const scopes = await post('Runtime.getProperties', { objectId: scopesEntry.value.objectId, ownProperties: false });
    for (const scope of scopes.result || []) {
      if (!scope.value?.objectId) { continue; }
      const vars = await post('Runtime.getProperties', { objectId: scope.value.objectId, ownProperties: true });
      for (const v of vars.result || []) {
        if (!v.value?.objectId) { continue; }
        // Probe: does this object have openTask + getChatManagerByTaskId?
        const probe = await post('Runtime.callFunctionOn', {
          objectId: v.value.objectId,
          functionDeclaration: 'function(){return typeof this.openTask==="function" && typeof this.getChatManagerByTaskId==="function";}',
          returnByValue: true,
        });
        if (probe.result?.value === true) {
          // Found Nh. Send into the existing task.
          const send = await post('Runtime.callFunctionOn', {
            objectId: v.value.objectId,
            functionDeclaration:
              'function(taskId, text){ return Promise.resolve(this.openTask({taskId})).then(m => m.handleInputMessage({type:"userMessage", content:text, mode:"agent", meta:{mask:text}})); }',
            arguments: [{ value: taskId }, { value: text }],
            awaitPromise: true,
            returnByValue: false,
          });
          if (send.exceptionDetails) { return 'FAIL: send threw: ' + JSON.stringify(send.exceptionDetails); }
          return 'OK: sent to ' + taskId + ' (closure var: ' + v.name + ')';
        }
      }
    }
    return 'FAIL: TaskManager not found in any closure scope';
  } finally {
    session.disconnect();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).__csw_bobApi;
  }
}
