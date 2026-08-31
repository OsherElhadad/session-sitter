/**
 * The supervision orchestrator: the only place that sequences the lifecycle.
 *
 *     load transcript -> route+parse BDI -> build prompt -> classify -> validate -> act -> persist
 *
 * Ported from the Python supervisor (`orchestrator.py`. It enforces the state machine, the
 * identity/safety rules, and the Orange timeout / Yellow fallback. It never keeps a classifier
 * alive while waiting on a human — Orange persists and returns; `poll()` resumes later
 * (idempotently, restart-safe).
 */

import { AgentController } from './agentControl';
import { SupervisorConfig } from './config';
import { ClassifierEngine, EngineError } from './engine';
import {
  FetchFn,
  KnowledgeBundle,
  KnowledgeError,
  loadKnowledge,
} from './knowledge';
import {
  DeliveryError,
  MessagingChannel,
} from './messaging';
import {
  Assessment,
  AssessmentInput,
  SupervisionRecord,
  SupervisionState,
  TrafficLight,
} from './models';
import { buildSupervisionPrompt } from './prompt';
import { formatAnswerDeliveryText, normalizeQuestion, questionSpecFrom } from './questions';
import {
  SchemaError,
  parseAndValidate,
  salvageAssessmentFromText,
  unclassifiedOrangeAssessment,
  validate,
} from './schema';
import { localHostName, sessionNameFrom } from './sessionIdentity';
import { LockBusy, StateStore } from './store';
import { applyToggle } from './telegram';
import { actionLabel, greenAssessment, preClassify, redAssessment } from './tiers';
import { Clock, deadlineFrom, isPast, nowUtc, toIso } from './timeutil';
import { NormalizedSession, TranscriptError, TranscriptSource, originalRequest } from './transcript';

/** Sentinel session id for "the active agent session" — resolved at delivery time. */
export const ACTIVE_SESSION = '@active';

export interface OrchestratorOptions {
  config: SupervisorConfig;
  store: StateStore;
  transcriptSource: TranscriptSource;
  engine: ClassifierEngine;
  channel: MessagingChannel;
  agentController: AgentController;
  clock?: Clock;
  /** Optional injected BDI fetch (tests use a fast local read). */
  knowledgeFetch?: FetchFn;
  log?: (msg: string) => void;
}

export class Orchestrator {
  readonly config: SupervisorConfig;
  readonly store: StateStore;
  readonly channel: MessagingChannel;
  private readonly transcript: TranscriptSource;
  private readonly engine: ClassifierEngine;
  private readonly agent: AgentController;
  private readonly clock: Clock;
  private readonly knowledgeFetch?: FetchFn;
  private readonly log: (msg: string) => void;

  constructor(opts: OrchestratorOptions) {
    this.config = opts.config;
    this.store = opts.store;
    this.transcript = opts.transcriptSource;
    this.engine = opts.engine;
    this.channel = opts.channel;
    this.agent = opts.agentController;
    this.clock = opts.clock ?? nowUtc;
    this.knowledgeFetch = opts.knowledgeFetch;
    this.log = opts.log ?? (() => { /* silent */ });
  }

  // ------------------------------------------------------------------ helpers

  private event(record: SupervisionRecord, kind: string, data: Record<string, unknown> = {}): void {
    record.events.push({ type: kind, at: toIso(this.clock()), ...data });
  }

  private async fail(record: SupervisionRecord, error: string): Promise<SupervisionRecord> {
    record.state = SupervisionState.FAILED;
    record.error = error;
    this.event(record, 'failed', { error });
    await this.store.save(record);
    return record;
  }

  /**
   * Ask a question via the messaging channel (options as tappable buttons) and await the human's
   * choice. Never touches the agent's approval emitter — the answer is delivered later (see
   * `resolveQuestionReply`), because resolving a question through the approval channel consumes
   * the request and the agent stops showing its options.
   */
  private async askQuestion(
    record: SupervisionRecord, session: NormalizedSession,
  ): Promise<SupervisionRecord> {
    const spec = normalizeQuestion(session);
    if (spec === null) { return this.fail(record, 'not a question'); } // defensive
    record.question_spec = spec as unknown as Record<string, unknown>;
    record.await_light = TrafficLight.ORANGE; // reuse the orange awaiting lifecycle
    const prompt = spec.prompt;
    const options = spec.questions.length ? spec.questions[0].options.map(o => o.label) : [];
    const note = `The agent is asking:\n${prompt}`;
    const assessment: AssessmentInput = {
      traffic_light: 'orange', confidence: 1.0,
      summary: `The agent is asking: ${prompt.slice(0, 80)}`,
      agent_intent: prompt, user_intent: originalRequest(session) || '(unknown)',
      waiting_reason: session.waitingReason || 'awaiting your answer',
      issues: [], recommended_action: 'Answer the question.',
      supervisor_message_to_agent: null, human_notification: note,
      human_options: options, allowed_actions_while_waiting: [], blocked_actions: [],
      should_block_agent: false, should_block_original_action: false,
      transitioned_from: null, transition_reason: null,
    };
    record.assessment = assessment;
    record.state = SupervisionState.ORANGE_AWAITING_QUESTION;
    record.timeout_deadline = deadlineFrom(this.clock(), this.config.orangeResponseTimeoutMinutes);
    this.event(record, 'question_asked', { options: options.length });
    try {
      const res = await this.channel.send(record, note, true);
      record.notification_id = res.messageId;
      record.notified_at = res.sentAt;
    } catch (err) {
      if (!(err instanceof DeliveryError)) { throw err; }
      this.event(record, 'question_notify_failed', { error: String(err) });
    }
    await this.store.save(record);
    return record;
  }

  /**
   * One-way informational update (green/yellow). Never changes the decision — a failed update is
   * logged and dropped, mirroring the Red-notify policy.
   */
  private async notifyUpdate(
    record: SupervisionRecord, assessment: Record<string, unknown>,
  ): Promise<void> {
    const text = String(assessment.summary || assessment.recommended_action || '(no summary)');
    try {
      const res = await this.channel.send(record, text, false);
      record.notification_id = res.messageId;
      record.notified_at = res.sentAt;
    } catch (err) {
      if (!(err instanceof DeliveryError)) { throw err; }
      this.event(record, 'update_notify_failed', { error: String(err) });
    }
  }

  private async loadBundle(record: SupervisionRecord): Promise<KnowledgeBundle> {
    // With no user configured there is nothing to route: supervision still judges the pending
    // action, just without BDI to weigh it against. Failing the decision here would strand the
    // agent at its prompt over a missing setting, which is exactly what must never happen.
    if (!record.user) {
      this.log('knowledge: no user configured; classifying without BDI knowledge');
      return {
        user: '', project: '', team: '', entries: [],
        loadedFiles: [], missingFiles: ['(knowledge routing not configured)'],
      };
    }
    return loadKnowledge({
      user: record.user,
      project: record.project,
      team: record.team,
      registryPath: this.config.knowledgeRegistryPath || undefined,
      localRepo: this.config.knowledgeLocalRepo || undefined,
      knowledgeRepo: this.config.knowledgeRepo || undefined,
      knowledgeRef: this.config.knowledgeRef,
      fetch: this.knowledgeFetch,
    });
  }

  // ------------------------------------------------------------------ supervise

  async supervise(
    sessionId: string,
    routing: { user?: string | null; project?: string | null; team?: string | null } = {},
  ): Promise<SupervisionRecord> {
    try {
      return await this.store.withSessionLock(
        sessionId, () => this.superviseLocked(sessionId, routing));
    } catch (err) {
      if (!(err instanceof LockBusy)) { throw err; }
      // Another supervision is in flight for this session; return the active one if any.
      const existing = await this.store.activeOrangeForSession(sessionId);
      if (existing !== null) { return existing; }
      throw err;
    }
  }

  private async superviseLocked(
    sessionId: string,
    routing: { user?: string | null; project?: string | null; team?: string | null },
  ): Promise<SupervisionRecord> {
    // Suppress a duplicate active Orange for the same unresolved decision.
    const existing = await this.store.activeOrangeForSession(sessionId);
    if (existing !== null) {
      this.event(existing, 'duplicate_supervise_suppressed');
      await this.store.save(existing);
      return existing;
    }

    // Load the transcript to learn the source + routing hints (user from the export if absent).
    let session: NormalizedSession;
    try {
      session = await this.transcript.load(sessionId);
    } catch (err) {
      if (!(err instanceof TranscriptError)) { throw err; }
      // No transcript, so no name — but the host is still worth recording: a failed decision
      // has to be attributable to a machine, and that is the one thing we know here.
      const record = await this.store.create(sessionId, 'unknown', {
        user: routing.user ?? null, project: routing.project ?? null, team: routing.team ?? null,
        host: localHostName() || null,
      });
      return this.fail(record, `transcript: ${err.message}`);
    }

    const record = await this.store.create(sessionId, session.source, {
      user: routing.user ?? session.user ?? null,
      project: routing.project ?? null,
      team: routing.team ?? null,
      // Name the session on the record itself: the card and the feed must say which session a
      // decision belongs to, and by then the transcript is long gone.
      session_name: sessionNameFrom(session),
      host: localHostName() || null,
    });
    if (session.pendingAction) {
      record.pending_request_id = session.pendingAction.requestId;
    }

    // A user-facing QUESTION must never be resolved through the approval emitter — that consumes
    // the request and the agent stops showing its options. Relay it and let the human answer.
    const pa = session.pendingAction;
    if (pa !== null && (pa.kind === 'question'
      || pa.name === 'ask_followup_question' || pa.name === 'AskUserQuestion')) {
      return this.askQuestion(record, session);
    }

    // Tier 1 (deterministic): decide the obvious cases WITHOUT a model call.
    //   GREEN → read-only/safe: auto-approve + green update.
    //   RED   → destructive: interactive block card + timer.
    const tier = preClassify(session);
    if (tier === TrafficLight.GREEN) {
      const assessment = greenAssessment(session);
      record.assessment = assessment;
      this.event(record, 'tier_green_no_model');
      return this.act(record, assessment, TrafficLight.GREEN);
    }
    if (tier === TrafficLight.RED) {
      const assessment = redAssessment(session);
      record.assessment = assessment;
      this.event(record, 'tier_red_no_model');
      return this.act(record, assessment, TrafficLight.RED);
    }

    let bundle: KnowledgeBundle;
    try {
      bundle = await this.loadBundle(record);
    } catch (err) {
      if (!(err instanceof KnowledgeError)) { throw err; }
      return this.fail(record, `knowledge: ${err.message}`);
    }
    record.user = bundle.user;
    record.project = bundle.project;
    record.team = bundle.team;

    const prompt = buildSupervisionPrompt(session, bundle);
    let result;
    try {
      result = await this.engine.classify(prompt);
    } catch (err) {
      if (!(err instanceof EngineError)) { throw err; }
      return this.fail(record, `classify: ${err.message}`);
    }
    record.engine_invocation_id = result.invocationId;

    let assessment: Assessment;
    try {
      assessment = parseAndValidate(result.raw);
    } catch (err) {
      if (!(err instanceof SchemaError)) { throw err; }
      // The agent CLI decided but narrated it as prose instead of JSON (Bob does this
      // intermittently). Salvage the light from the prose; if even that fails, escalate to the
      // human (orange) rather than hard-fail — the supervisor must NEVER strand the agent on a
      // blocked prompt because the classifier returned something unparsable.
      const label = actionLabel(session);
      let salvaged = salvageAssessmentFromText(result.raw, label);
      if (salvaged !== null) {
        this.event(record, 'salvaged_from_prose', { light: salvaged.traffic_light });
      } else {
        salvaged = unclassifiedOrangeAssessment(label, result.raw);
        this.event(record, 'classify_unparsable_defaulted_orange');
      }
      assessment = validate(salvaged);
    }

    record.assessment = assessment as unknown as Record<string, unknown>;
    return this.act(
      record, assessment as unknown as Record<string, unknown>,
      assessment.traffic_light as TrafficLight);
  }

  private async act(
    record: SupervisionRecord,
    assessment: Record<string, unknown>,
    light: TrafficLight,
  ): Promise<SupervisionRecord> {
    if (light === TrafficLight.GREEN) {
      // Approve the live prompt so the agent proceeds, then post a one-way green update.
      if (record.pending_request_id) {
        const d = await this.agent.deliver({
          sessionId: record.session_id, source: record.source,
          text: 'Approved by supervisor (safe action).', kind: 'approve_approval',
          requestId: record.pending_request_id, decision: 'allow',
        });
        record.delivery_ids.push(d.deliveryId);
      }
      record.state = SupervisionState.GREEN_COMPLETED;
      await this.notifyUpdate(record, assessment);
      this.event(record, 'green_approved');
      await this.store.save(record);
      return record;
    }

    if (light === TrafficLight.YELLOW) {
      return this.deliverYellow(record, assessment, 'yellow_guidance');
    }

    // Red and Orange both ask the human (card + choices + timer) and wait.
    return this.actInteractive(record, assessment, light);
  }

  private async deliverYellow(
    record: SupervisionRecord, assessment: Record<string, unknown>, kind: string,
  ): Promise<SupervisionRecord> {
    const message = String(assessment.supervisor_message_to_agent ?? '');
    record.state = SupervisionState.YELLOW_READY;
    await this.store.save(record);
    const delivery = await this.agent.deliver({
      sessionId: record.session_id, source: record.source, text: message, kind,
    });
    record.delivered_message = delivery.text;
    record.delivery_ids.push(delivery.deliveryId);
    record.blocked_actions = asStringList(assessment.blocked_actions);
    record.allowed_actions = asStringList(assessment.allowed_actions_while_waiting);
    record.should_block_original_action = assessment.should_block_original_action === true;
    record.state = SupervisionState.YELLOW_DELIVERED;
    await this.notifyUpdate(record, assessment); // one-way update (yellow still auto-corrects)
    this.event(record, 'yellow_delivered', { delivery_id: delivery.deliveryId });
    await this.store.save(record);
    return record;
  }

  /**
   * Red/Orange: post an interactive card (choices + timer) and await. The agent stays paused at
   * its prompt meanwhile — we resolve it only on the human's answer or on timeout.
   */
  private async actInteractive(
    record: SupervisionRecord, assessment: Record<string, unknown>, light: TrafficLight,
  ): Promise<SupervisionRecord> {
    const notification = String(assessment.human_notification ?? assessment.summary ?? '');
    let res;
    try {
      res = await this.channel.send(record, notification, true);
    } catch (err) {
      if (!(err instanceof DeliveryError)) { throw err; }
      return this.fail(record, `notification delivery failed: ${err.message}`);
    }

    const now = this.clock();
    record.notification_id = res.messageId;
    record.notified_at = res.sentAt;
    record.timeout_deadline = deadlineFrom(now, this.config.orangeResponseTimeoutMinutes);
    record.original_orange_assessment = assessment;
    record.original_orange_assessment_id = record.request_id;
    record.await_light = light;
    record.blocked_actions = asStringList(assessment.blocked_actions);
    record.allowed_actions = asStringList(assessment.allowed_actions_while_waiting);
    record.should_block_original_action = true;
    record.should_block_agent = light === TrafficLight.RED;
    record.state = SupervisionState.ORANGE_AWAITING_USER;
    this.event(record, 'awaiting_user', { light, deadline: record.timeout_deadline });
    await this.store.save(record);
    return record;
  }

  // -- apply an approve / deny outcome to the agent ---------------------------

  private async approveAction(record: SupervisionRecord, reason: string): Promise<void> {
    if (record.pending_request_id) {
      const d = await this.agent.deliver({
        sessionId: record.session_id, source: record.source, text: reason,
        kind: 'approve_approval', requestId: record.pending_request_id, decision: 'allow',
      });
      record.delivery_ids.push(d.deliveryId);
    }
  }

  /** Reject the live prompt; for Orange also send the agent alternatives so it can continue. */
  private async denyAction(
    record: SupervisionRecord, assessment: Record<string, unknown>, reason: string,
  ): Promise<void> {
    if (record.pending_request_id) {
      const d = await this.agent.deliver({
        sessionId: record.session_id, source: record.source, text: reason,
        kind: 'reject_approval', requestId: record.pending_request_id, decision: 'reject',
      });
      record.delivery_ids.push(d.deliveryId);
    }
    record.should_block_agent = record.await_light === TrafficLight.RED;
    if (record.await_light === TrafficLight.ORANGE) {
      const alt = alternativesMessage(assessment);
      const d2 = await this.agent.deliver({
        sessionId: record.session_id, source: record.source, text: alt,
        kind: 'orange_alternatives',
      });
      record.delivered_message = d2.text;
      record.delivery_ids.push(d2.deliveryId);
    }
  }

  /** Relay a general message from the user straight to the active agent session. */
  private async forwardToAgent(text: string): Promise<void> {
    if (!text.trim()) { return; }
    await this.agent.deliver({
      sessionId: ACTIVE_SESSION, source: 'bob',
      text: `(from user via messaging) ${text}`, kind: 'telegram_message',
    });
  }

  // ------------------------------------------------------------------ poll (resumer)

  async poll(): Promise<SupervisionRecord[]> {
    const processed: SupervisionRecord[] = [];
    const awaitingUser = await this.store.byState(SupervisionState.ORANGE_AWAITING_USER);
    const awaitingQuestion = await this.store.byState(SupervisionState.ORANGE_AWAITING_QUESTION);
    const pending = [...awaitingUser, ...awaitingQuestion];

    // 1. Correlate replies to LIVE cards only (so a message after a card resolved is treated as
    //    a general instruction, not a stale "late reply").
    const handled = new Set<string>();
    for (const resp of await this.channel.pollResponses(pending)) {
      if (await this.store.isUpdateConsumed(resp.updateId)) { continue; }
      // A general message (not a reply to a live card) → forward straight to the agent.
      if (resp.correlationId === ACTIVE_SESSION) {
        await this.store.markUpdateConsumed(resp.updateId);
        await this.forwardToAgent(resp.text);
        continue;
      }
      const record = await this.store.get(resp.correlationId);
      if (record === null) { continue; }
      await this.store.markUpdateConsumed(resp.updateId);
      if (record.state === SupervisionState.ORANGE_AWAITING_QUESTION) {
        processed.push(await this.resolveQuestionReply(record, resp.text, resp.receivedAt));
        handled.add(record.request_id);
        continue;
      }
      if (record.state !== SupervisionState.ORANGE_AWAITING_USER) {
        // Late reply after a transition/resolution: record it, never auto-authorize.
        this.event(record, 'late_reply', { text: resp.text });
        await this.store.save(record);
        processed.push(record);
        continue;
      }
      processed.push(await this.resolveWithReply(record, resp.text, resp.receivedAt));
      handled.add(record.request_id);
    }

    // 2. Timeouts for those still awaiting.
    for (const record of await this.store.byState(SupervisionState.ORANGE_AWAITING_USER)) {
      if (handled.has(record.request_id)) { continue; }
      if (record.timeout_deadline && isPast(record.timeout_deadline, this.clock())) {
        processed.push(await this.timeout(record));
      }
    }

    // 3. Question timeouts: no answer produced — the agent stays waiting for the human (silence
    //    is not an answer). We simply stop tracking the card.
    for (const record of awaitingQuestion) {
      if (handled.has(record.request_id)) { continue; }
      if (record.timeout_deadline && isPast(record.timeout_deadline, this.clock())) {
        this.event(record, 'question_timed_out');
        record.state = SupervisionState.ORANGE_TIMED_OUT;
        await this.store.save(record);
        processed.push(record);
      }
    }

    return processed;
  }

  /** Tick the countdown on any awaiting cards (no-op for channels without it). */
  async refreshTimers(): Promise<void> {
    if (!this.channel.refreshTimers) { return; }
    await this.channel.refreshTimers(
      await this.store.byState(SupervisionState.ORANGE_AWAITING_USER));
  }

  /**
   * Words (as whole words) that mean "let the ORIGINAL action proceed". Anything else — including
   * redirects like "Create PR", "Just commit", "Cancel" — denies it and relays the instruction.
   */
  static readonly APPROVE_WORDS: ReadonlySet<string> = new Set([
    'approve', 'approved', 'allow', 'yes', 'ok', 'okay', 'proceed', 'accept', 'go', 'confirm',
  ]);

  static replyApproves(reply: string): boolean {
    const words = reply.toLowerCase()
      .split('')
      .map(c => (/[a-z0-9]/.test(c) ? c : ' '))
      .join('')
      .split(/\s+/)
      .filter(w => w.length > 0);
    return words.some(w => Orchestrator.APPROVE_WORDS.has(w));
  }

  /**
   * Deterministic + fast (NO second model call — that "resolve classify" path was fragile and
   * slow). We ALWAYS relay the user's own words to the agent so it corrects direction, and we
   * resolve the blocked approval: an explicit approval lets the original action proceed;
   * anything else (a redirect like "Create PR" / "Just commit" / "Cancel") denies it.
   */
  private async resolveWithReply(
    record: SupervisionRecord, reply: string, receivedAt: string,
  ): Promise<SupervisionRecord> {
    record.user_response = reply;
    record.user_response_at = receivedAt;
    const approve = Orchestrator.replyApproves(reply);

    if (approve) {
      await this.approveAction(record, `Approved by user via messaging: ${reply}`);
    } else if (record.pending_request_id) {
      const d = await this.agent.deliver({
        sessionId: record.session_id, source: record.source,
        text: `Denied by user via messaging: ${reply}`, kind: 'reject_approval',
        requestId: record.pending_request_id, decision: 'reject',
      });
      record.delivery_ids.push(d.deliveryId);
      record.should_block_agent = record.await_light === TrafficLight.RED;
    }

    // Relay the user's instruction so the agent follows the new direction (this is what makes it
    // correct course). Injected into the (now-unblocked) session as a chat message.
    const relay = await this.agent.deliver({
      sessionId: record.session_id, source: record.source,
      text: `The user answered: "${reply}". Follow this instruction.`, kind: 'user_relay',
    });
    record.delivered_message = relay.text;
    record.delivery_ids.push(relay.deliveryId);

    record.state = SupervisionState.ORANGE_RESOLVED_BY_USER;
    this.event(record, 'resolved_by_user', {
      outcome: approve ? 'approve' : 'deny', reply, light: record.await_light,
    });
    await this.store.save(record);
    return record;
  }

  /** Whether the sub-question keyed `q<idx>` is multi-select. */
  private static multiFor(spec: { questions: Array<{ multi_select: boolean }> }, qkey: string): boolean {
    if (!/^q\d+$/.test(qkey)) { return false; }
    const qi = Number(qkey.slice(1));
    return qi < spec.questions.length && spec.questions[qi].multi_select;
  }

  /**
   * Remap the draft's `q<idx>` keys to their question text (the shape both the message formatter
   * and the native question resolve consume).
   */
  private static answersByQuestionText(
    spec: { questions: Array<{ question: string }> },
    draft: { answers?: Record<string, string[]> } | null,
  ): Record<string, string[]> {
    const answers = draft?.answers ?? {};
    const out: Record<string, string[]> = {};
    spec.questions.forEach((q, qi) => {
      const chosen = answers[`q${qi}`];
      if (chosen && chosen.length) { out[q.question] = [...chosen]; }
    });
    return out;
  }

  /**
   * A tap/reply on a question card. Toggles accumulate the draft and keep the card awaiting; a
   * submit (or free-text) finalizes: Bob gets the answer as a user message, Claude gets it via
   * the native question channel (resolving its blocked tool).
   */
  private async resolveQuestionReply(
    record: SupervisionRecord, reply: string, receivedAt: string,
  ): Promise<SupervisionRecord> {
    const spec = questionSpecFrom(record.question_spec ?? {});
    const draft = (record.question_answer ?? { request_id: spec.request_id, answers: {} }) as
      { request_id?: string | null; answers?: Record<string, string[]> };

    // Toggle: flip one option into the draft and keep waiting for more taps / a submit.
    if (reply.startsWith('__toggle|')) {
      const parts = reply.split('|');
      const qkey = parts[1] ?? '';
      const label = parts.slice(2).join('|');
      record.question_answer = applyToggle(
        draft, qkey, label, Orchestrator.multiFor(spec, qkey)) as unknown as Record<string, unknown>;
      this.event(record, 'question_toggle', { qkey, label });
      await this.store.save(record);
      return record;
    }

    // Free-text (non-submit) reply: treat as the answer to the first question.
    if (reply !== '__submit') {
      record.question_answer = applyToggle(
        draft, 'q0', reply, Orchestrator.multiFor(spec, 'q0')) as unknown as Record<string, unknown>;
    }

    const answersByText = Orchestrator.answersByQuestionText(
      spec, (record.question_answer ?? draft) as { answers?: Record<string, string[]> });
    record.user_response = reply;
    record.user_response_at = receivedAt;

    let d;
    if (record.source === 'claude') {
      d = await this.agent.deliver({
        sessionId: record.session_id, source: 'claude', text: '(answers)',
        kind: 'answer_question', requestId: spec.request_id, channel: 'question',
        answers: answersByText,
      });
    } else {
      const text = formatAnswerDeliveryText(record.question_spec, { answers: answersByText });
      d = await this.agent.deliver({
        sessionId: record.session_id, source: record.source, text, kind: 'answer_question',
      });
    }
    record.delivered_message = d.text;
    record.delivery_ids.push(d.deliveryId);
    record.state = SupervisionState.ORANGE_RESOLVED_BY_USER;
    this.event(record, 'question_resolved_by_user', { reply });
    await this.store.save(record);
    return record;
  }

  private async timeout(record: SupervisionRecord): Promise<SupervisionRecord> {
    // Idempotent: only act on a still-awaiting record.
    if (record.state !== SupervisionState.ORANGE_AWAITING_USER) { return record; }
    const assessment = record.original_orange_assessment ?? {};
    this.event(record, 'timed_out', { light: record.await_light });
    // Silence is not approval: red blocks; orange denies + hands the agent safe alternatives.
    await this.denyAction(record, assessment, 'Timed out with no reply — not approved.');
    record.transitioned_from = record.await_light;
    record.transition_reason = 'user_response_timeout';
    record.should_block_original_action = true;
    record.state = record.await_light === TrafficLight.RED
      ? SupervisionState.RED_BLOCKED
      : SupervisionState.ORANGE_TRANSITIONED_TO_YELLOW;
    this.event(record, 'timeout_resolved', { light: record.await_light });
    await this.store.save(record);
    return record;
  }
}

function asStringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** The message handed to the agent when the original action was not approved. */
export function alternativesMessage(assessment: Record<string, unknown>): string {
  const msg = assessment.supervisor_message_to_agent;
  if (msg) { return String(msg); }
  const rec = String(assessment.recommended_action ?? '');
  const allowed = Array.isArray(assessment.allowed_actions_while_waiting)
    ? assessment.allowed_actions_while_waiting : [];
  const parts = ['The original action was not approved. Do not perform it.'];
  if (rec) { parts.push(`Instead: ${rec}`); }
  if (allowed.length) {
    parts.push(`Safe alternatives you may proceed with: ${allowed.map(String).join('; ')}.`);
  }
  return parts.join(' ');
}
