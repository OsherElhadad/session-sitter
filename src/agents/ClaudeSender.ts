import * as vscode from 'vscode';
import { callOnClaudeManager } from './ClaudeInspector';
import { shouldAttemptSend, type MessageSender } from './BobSender';

/**
 * The user-message envelope Claude Code writes to the CLI subprocess stdin.
 * Confirmed from the extension bundle (v2.1.138): its own single-message helper
 * does `transport.write(JSON.stringify({type:"user",session_id:"",message:{role:
 * "user",content:[{type:"text",text}]},parent_tool_use_id:null}) + "\n")`.
 * `session_id: ""` is accepted — the CLI fills it in. Pure — unit-tested.
 */
export function buildClaudeUserMessage(text: string): Record<string, unknown> {
  return {
    type: 'user',
    session_id: '',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  };
}

/**
 * Build the function injected into Claude's ext-host (with `this` = the manager).
 * v1 targeting: gather every channel across all comms; write only when there is
 * exactly ONE (the common single-conversation case). More than one → 'ambiguous'
 * (we cannot map sessionId→channel from the extension side; see the findings
 * note). The message envelope is computed in TS and embedded as a JSON literal,
 * so the injected code just appends a newline and writes it to the CLI stdin.
 */
export function buildInjectFn(text: string): string {
  const payload = JSON.stringify(buildClaudeUserMessage(text));
  return `function(){
    try {
      var payload = ${JSON.stringify(payload)};
      var chans = [];
      if (this.allComms && this.allComms.forEach) {
        this.allComms.forEach(function(c){
          if (c && c.channels && c.channels.forEach) c.channels.forEach(function(ch){ chans.push(ch); });
        });
      }
      if (chans.length === 0) return 'no-channel';
      if (chans.length > 1) return 'ambiguous:' + chans.length;
      var t = chans[0] && chans[0].query && chans[0].query.transport;
      if (!t || typeof t.write !== 'function') return 'no-transport';
      t.write(payload + String.fromCharCode(10));
      return 'ok';
    } catch (e) { return 'err:' + String(e); }
  }`;
}

/**
 * Injects a user message into a running Claude Code session by reaching the live
 * manager via the V8 inspector and writing the message envelope to the sole
 * channel's CLI transport. Implements the same `MessageSender` interface the
 * AutoResponder consumes for Bob. Never throws — logs and no-ops on any failure.
 *
 * v1 limitation: because the sessionId↔channel link lives in the webview (not the
 * extension), this targets the single open channel and skips when several are
 * open. `sessionId` is accepted for interface parity and logging.
 */
export class InspectorClaudeSender implements MessageSender {
  constructor(private readonly log: (msg: string) => void) {}

  async isAvailable(): Promise<boolean> {
    return !!vscode.extensions.getExtension('anthropic.claude-code');
  }

  async send(sessionId: string, text: string): Promise<void> {
    if (!shouldAttemptSend(sessionId, text)) {
      this.log('claude send skipped: empty sessionId or text');
      return;
    }
    const result = await this.inject(text);
    if (result === 'ok') {
      this.log(`claude send: delivered to sole channel (session ${sessionId})`);
    } else {
      this.log(`claude send: not delivered (session ${sessionId}) → ${result}`);
    }
  }

  /** Run the injection and return the raw status string
   *  ('ok' | 'no-channel' | 'ambiguous:N' | 'no-transport' | 'err:…') or a reach
   *  diag (e.g. 'gB-not-found'). Exposed so the test command can surface it
   *  directly instead of only logging. Does not guard — callers pass fixed text. */
  async inject(text: string): Promise<string> {
    const { raw, diag } = await callOnClaudeManager(buildInjectFn(text), this.log);
    return raw ?? `diag:${diag}`;
  }
}
