import type { AutoRespondRule } from './BobSender';
import type { MessageExchange } from './SessionManager';

/** Return the first rule whose pattern matches the assistant text. Invalid
 *  regex patterns are skipped (never throw). */
export function matchRule(assistantText: string, rules: AutoRespondRule[]): AutoRespondRule | undefined {
  for (const rule of rules) {
    let re: RegExp;
    try { re = new RegExp(rule.matchPattern); } catch { continue; }
    if (re.test(assistantText)) { return rule; }
  }
  return undefined;
}

/** Stable identity for a message, used for dedup. */
export function messageKey(ex: MessageExchange): string {
  return ex.timestamp ?? ex.text;
}
