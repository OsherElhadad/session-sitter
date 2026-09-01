#!/usr/bin/env node
/**
 * Session Sitter statusline — the traffic-light state and this session's decision count.
 *
 * Hand-written JavaScript rather than compiled output, because it is twenty lines of formatting with
 * no logic worth a test and no engine to share. Everything that decides anything lives in
 * `plugin/lib/`.
 *
 * Reads only documented stdin fields: `session_id`, and `workspace.current_dir` as a fallback label.
 * Notably it does **not** call `tput` — statusline output is captured rather than attached to a tty,
 * so `tput cols` fails; Claude Code sets `COLUMNS` and `LINES` in the environment instead.
 *
 * Wire it up in settings.json:
 *
 *     "statusLine": { "type": "command",
 *                     "command": "node ~/.claude/plugins/.../plugin/statusline.js",
 *                     "refreshInterval": 5 }
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const RESET = '[0m';
const COLOR = { green: '[32m', yellow: '[33m', red: '[31m', dim: '[2m' };

function dataDir() {
  return process.env.SESSION_SITTER_DATA_DIR
    || process.env.CLAUDE_PLUGIN_DATA
    || path.join(os.homedir(), '.claude', 'session-sitter');
}

/** This session's decision records. Reads the rotated generation too, and tolerates a bad line. */
function decisionsFor(sessionId) {
  const base = path.join(dataDir(), 'decisions.jsonl');
  const rows = [];
  for (const file of [`${base}.1`, base]) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) { continue; }
      try {
        const row = JSON.parse(line);
        if (!sessionId || row.sessionId === sessionId) { rows.push(row); }
      } catch {
        // A partially written line. Skip it.
      }
    }
  }
  return rows;
}

/**
 * The light for the session as a whole: red the moment anything was denied, yellow when anything was
 * corrected, green otherwise. Worst-case wins, because a statusline that shows the average hides the
 * one record you needed to see.
 */
function lightFor(rows) {
  if (rows.some(r => r.decision === 'deny')) { return 'red'; }
  if (rows.some(r => r.rewritten)) { return 'yellow'; }
  return 'green';
}

function render(input) {
  const rows = decisionsFor(input.session_id);
  if (rows.length === 0) {
    return `${COLOR.dim}sitter: no decisions yet${RESET}`;
  }
  const light = lightFor(rows);
  const denied = rows.filter(r => r.decision === 'deny').length;
  const fixed = rows.filter(r => r.rewritten).length;
  const parts = [`${rows.length} decision${rows.length === 1 ? '' : 's'}`];
  if (fixed) { parts.push(`${fixed} corrected`); }
  if (denied) { parts.push(`${denied} denied`); }
  // The last clause applied is the most useful single thing to show: it says which rule is live.
  const lastClause = [...rows].reverse().find(r => r.clause);
  if (lastClause) { parts.push(`${COLOR.dim}${lastClause.clause}${RESET}`); }

  const line = `${COLOR[light]}●${RESET} sitter ${parts.join(' · ')}`;
  // COLUMNS is what Claude Code provides; `tput cols` cannot work here. Trim on the visible length,
  // so an escape sequence is never counted against the budget or cut in half.
  const columns = Number.parseInt(process.env.COLUMNS || '', 10);
  if (!Number.isFinite(columns) || columns <= 0) { return line; }
  const visible = line.replace(/\[[0-9;]*m/g, '');
  if (visible.length <= columns) { return line; }
  return `${COLOR[light]}●${RESET} sitter ${rows.length}d ${fixed}c ${denied}x`;
}

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { stdin += chunk; });
process.stdin.on('end', () => {
  let input = {};
  try {
    input = JSON.parse(stdin) || {};
  } catch {
    // No payload (a hand-run test) — render the no-session line rather than failing.
  }
  process.stdout.write(`${render(input)}\n`);
});
