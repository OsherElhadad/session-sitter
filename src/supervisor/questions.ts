/**
 * Source-agnostic structured-question model + normalization.
 *
 * Ported from `reckon_supervisor/questions.py`. A Bob `ask_followup_question` and a Claude
 * `AskUserQuestion` both collapse into a `QuestionSpec` (1..N sub-questions, each with a flat
 * option list + a multi-select flag). Bob is always a single sub-question, single-select.
 *
 * The serialized form keeps Python's **snake_case** keys (`request_id`, `multi_select`) because
 * it is persisted inside a supervision record and read back by the messaging card builder.
 */

import type { NormalizedSession, PendingAction } from './transcript';

export interface Option {
  label: string;
  description: string;
}

export interface SubQuestion {
  question: string;
  header: string;
  options: Option[];
  multi_select: boolean;
}

export interface QuestionSpec {
  request_id: string | null;
  source: string;
  prompt: string;
  questions: SubQuestion[];
}

export interface QuestionAnswer {
  request_id: string | null;
  /** question text (or `q<idx>` while drafting) -> chosen labels */
  answers: Record<string, string[]>;
}

export function coerceOption(raw: unknown): Option {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    return {
      label: typeof o.label === 'string' ? o.label : String(o.label ?? ''),
      description: typeof o.description === 'string' ? o.description : String(o.description ?? ''),
    };
  }
  return { label: String(raw), description: '' };
}

export function questionSpecFrom(d: Record<string, unknown>): QuestionSpec {
  const rawQs = Array.isArray(d.questions) ? d.questions : [];
  return {
    request_id: (d.request_id as string | null) ?? null,
    source: typeof d.source === 'string' ? d.source : 'bob',
    prompt: typeof d.prompt === 'string' ? d.prompt : '',
    questions: rawQs
      .filter((q): q is Record<string, unknown> => !!q && typeof q === 'object')
      .map(q => ({
        question: String(q.question ?? ''),
        header: String(q.header ?? ''),
        options: (Array.isArray(q.options) ? q.options : []).map(coerceOption),
        multi_select: q.multi_select === true,
      })),
  };
}

export function questionAnswerFrom(d: Record<string, unknown>): QuestionAnswer {
  const raw = (d.answers && typeof d.answers === 'object' ? d.answers : {}) as Record<string, unknown>;
  const answers: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(raw)) {
    answers[String(k)] = (Array.isArray(v) ? v : [v]).map(x => String(x));
  }
  return { request_id: (d.request_id as string | null) ?? null, answers };
}

/**
 * Tool names that are user-facing questions (Bob's + Claude's). Defense-in-depth: even if an
 * export mislabels one as kind="tool_call", matching the name keeps it on the question-relay
 * path instead of the auto-approve path (which would answer it with no selection).
 */
const QUESTION_TOOLS: ReadonlySet<string> = new Set(['ask_followup_question', 'AskUserQuestion']);

export function isQuestion(session: NormalizedSession): boolean {
  const pa = session.pendingAction;
  return pa !== null && (pa.kind === 'question' || (pa.name !== null && QUESTION_TOOLS.has(pa.name)));
}

/** Turn a pending question into a QuestionSpec, or null when it is not a question. */
export function normalizeQuestion(session: NormalizedSession): QuestionSpec | null {
  if (!isQuestion(session)) { return null; }
  const pa = session.pendingAction!;
  if (session.source === 'claude' && pa.arguments && Array.isArray(pa.arguments.questions)
    && pa.arguments.questions.length > 0) {
    return normalizeClaude(pa);
  }
  return normalizeBob(pa);
}

/**
 * Render the chosen answers as a plain user-voice message for the agent.
 * One line per answered question: `<question>: <label>[, <label>...]`.
 */
export function formatAnswerDeliveryText(
  spec: Record<string, unknown> | null | undefined,
  answer: { answers?: Record<string, string[]> } | null | undefined,
): string {
  const answers = answer?.answers ?? {};
  const specQs = spec && Array.isArray(spec.questions) ? spec.questions : [];
  const order = specQs
    .filter((q): q is Record<string, unknown> => !!q && typeof q === 'object')
    .map(q => String(q.question ?? ''));
  const keys = order.length ? order : Object.keys(answers);
  const lines: string[] = [];
  for (const q of keys) {
    const chosen = answers[q] ?? [];
    if (chosen.length) { lines.push(`${q}: ${chosen.map(c => String(c)).join(', ')}`); }
  }
  return lines.join('\n');
}

function normalizeClaude(pa: PendingAction): QuestionSpec {
  const rawQs = (pa.arguments?.questions ?? []) as unknown[];
  const questions: SubQuestion[] = rawQs
    .filter((q): q is Record<string, unknown> => !!q && typeof q === 'object' && !Array.isArray(q))
    .map(q => ({
      question: String(q.question ?? ''),
      header: String(q.header ?? ''),
      options: (Array.isArray(q.options) ? q.options : []).map(coerceOption),
      multi_select: q.multiSelect === true,
    }));
  const prompt = questions.length
    ? questions[0].question
    : (pa.description || 'The agent is asking a question.');
  return { request_id: pa.requestId, source: 'claude', prompt, questions };
}

function normalizeBob(pa: PendingAction): QuestionSpec {
  const args = pa.arguments ?? {};
  // The tool arguments carry the real question text; the exporter's `description` is a generic
  // "Bob is asking … via ask_followup_question", so args wins and description is the fallback.
  const text = String(args.question ?? '') || (pa.description || '') || 'Bob is asking you a question.';
  const rawOpts = args.options ?? args.choices ?? [];
  const options = Array.isArray(rawOpts) ? rawOpts.map(coerceOption) : [];
  return {
    request_id: pa.requestId,
    source: 'bob',
    prompt: text,
    questions: [{ question: text, header: '', options, multi_select: false }],
  };
}
