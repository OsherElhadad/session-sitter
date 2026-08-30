import * as path from 'path';
import { PendingApproval } from './agents/BobApprover';
import { SessionExporter } from './SessionExporter';
import { loadConfig, SupervisorConfig } from './supervisor/config';
import { buildOrchestrator } from './supervisor/factory';
import { Orchestrator } from './supervisor/orchestrator';
import { SupervisionRecord } from './supervisor/models';

/**
 * Drives the runtime supervisor **in-process**.
 *
 * This replaces reckon's `SupervisionTrigger`, which spawned `python3 supervise.py run <id>` per
 * blocked prompt plus a long-lived `supervise.py poll --loop 1`. The supervisor is TypeScript
 * now, so there is no reason for a process boundary: this owns an `Orchestrator` directly.
 *
 * For each pending approval that no auto-approve rule handled, it
 *   1. exports the full transcript to `<stateDir>/history/<id>.json` via `SessionExporter`, then
 *   2. calls `orchestrator.supervise(id, routing)`.
 *
 * The orchestrator writes its decision as a delivery into `<stateDir>/outbox/`, which
 * `SupervisorOutbox` applies back into the agent. That queue is kept (it is what makes a failed
 * apply retryable and a crash mid-decision recoverable), but `onDelivered` kicks the applier
 * immediately, so an approval reaches the blocked agent in milliseconds instead of on the next
 * poll tick.
 *
 * A self-scheduling `poll()` loop handles messaging replies, timeouts, and countdown ticks. It
 * is self-scheduling rather than a fixed interval because a Telegram long-poll can block inside
 * `poll()` for several seconds, and overlapping passes would double-consume updates.
 */

export interface SupervisionServiceConfig {
  enabled: boolean;
  /** Shared state dir: `history/`, `outbox/`, `records/`, `inbox/` live here. */
  stateDir: string;
  /** Workspace root used to resolve `.env` files and as the classifier's cwd. */
  workspaceRoot: string;
  /** Knowledge routing triple. */
  user: string;
  project: string;
  team: string;
  /** Optional registry markdown that validates the triple. */
  knowledgeRegistryPath?: string;
  /** Local knowledge repo checkout (contains `data/knowledge/`). */
  knowledgeLocalRepo?: string;
  bobDbPath: string;
  /** Seconds between `poll()` passes. */
  pollIntervalSeconds?: number;
}

export class SupervisionService {
  private readonly triggered = new Set<string>();       // Bob requestIds handed off (dedup)
  private readonly triggeredClaude = new Set<string>(); // Claude requestIds handed off (dedup)
  private orchestrator: Orchestrator | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private polling = false;

  constructor(
    private readonly cfg: SupervisionServiceConfig,
    private readonly log: (msg: string) => void,
    /** Called after the orchestrator writes a delivery, so the applier can run at once. */
    private readonly onDelivered?: () => void,
  ) {}

  /** The supervisor configuration, settings layered over the environment and any `.env`. */
  supervisorConfig(): SupervisorConfig {
    const base = loadConfig({
      workspaceRoot: this.cfg.workspaceRoot,
      stateDir: this.cfg.stateDir,
      envFiles: [path.join(this.cfg.workspaceRoot, '.supervisor.env')],
    });
    // Extension settings win for knowledge routing; everything else stays env/.env driven so a
    // token never has to live in VS Code settings.
    return {
      ...base,
      knowledgeRegistryPath: this.cfg.knowledgeRegistryPath || base.knowledgeRegistryPath,
      knowledgeLocalRepo: this.cfg.knowledgeLocalRepo || base.knowledgeLocalRepo,
    };
  }

  /** Build the orchestrator lazily so a config error surfaces on first use, not at activation. */
  private get orch(): Orchestrator {
    if (!this.orchestrator) {
      this.orchestrator = buildOrchestrator({
        config: this.supervisorConfig(),
        onDelivered: this.onDelivered,
        log: this.log,
      });
    }
    return this.orchestrator;
  }

  start(): void {
    if (!this.cfg.enabled) {
      this.log('supervision disabled (claudeSessionSwitcher.autoSupervise=false)');
      return;
    }
    const cfg = this.supervisorConfig();
    this.log(
      `supervision started — engine=${cfg.supervisorEngine} channel=${cfg.messagingChannel} `
      + `stateDir=${cfg.stateDir} routing=${this.cfg.user}/${this.cfg.project}/${this.cfg.team}`,
    );
    void this.orch.channel.ensurePollingReady?.();
    this.scheduleNextPoll(0);
  }

  private scheduleNextPoll(delayMs: number): void {
    if (this.stopped) { return; }
    this.pollTimer = setTimeout(() => { void this.runPoll(); }, delayMs);
  }

  private async runPoll(): Promise<void> {
    if (this.stopped || this.polling) { return; }
    this.polling = true;
    try {
      // A single bad pass (transient API/parse error) must never kill the loop — otherwise
      // replies stop being consumed and every decision silently times out.
      const processed = await this.orch.poll();
      if (processed.length) {
        this.log(`supervision poll: processed ${processed.map(r => r.request_id).join(', ')}`);
      }
      await this.orch.refreshTimers();
    } catch (err) {
      this.log(`supervision poll: pass error (continuing): ${String(err)}`);
    } finally {
      this.polling = false;
      this.scheduleNextPoll((this.cfg.pollIntervalSeconds ?? 2) * 1000);
    }
  }

  /** Prune Bob requestIds no longer pending so a genuinely new request re-arms. */
  prune(stillPending: Set<string>): void {
    for (const id of [...this.triggered]) {
      if (!stillPending.has(id)) { this.triggered.delete(id); }
    }
  }

  /** Prune Claude requestIds no longer pending (a separate set from Bob's). */
  pruneClaude(stillPending: Set<string>): void {
    for (const id of [...this.triggeredClaude]) {
      if (!stillPending.has(id)) { this.triggeredClaude.delete(id); }
    }
  }

  /** Called for each pending Bob approval that NO auto-approve rule handled. */
  async maybeTrigger(p: PendingApproval): Promise<SupervisionRecord | undefined> {
    if (!this.cfg.enabled) { return undefined; }
    if (this.triggered.has(p.requestId)) { return undefined; }
    this.triggered.add(p.requestId); // mark before async work to avoid a double-trigger race

    try {
      const exporter = new SessionExporter(this.cfg.bobDbPath);
      const out = await exporter.exportBob(p.taskId, path.join(this.cfg.stateDir, 'history'), p);
      this.log(`supervision: exported ${p.taskId} (${p.toolName} req=${p.requestId}) -> ${out}`);
    } catch (err) {
      this.triggered.delete(p.requestId); // export failed → allow a retry next sweep
      this.log(`supervision: export failed for ${p.taskId}: ${String(err)}`);
      return undefined;
    }
    return this.superviseExported(p.taskId, `${p.toolName} req=${p.requestId}`, () => {
      this.triggered.delete(p.requestId);
    });
  }

  /**
   * Claude counterpart of {@link maybeTrigger}. A Claude pending approval's `taskId` is a
   * channelId (not a session id or transcript path), so the caller injects `doExport` — which
   * resolves the target Claude session, writes its transcript, and returns that exported id.
   * Deduped per requestId.
   */
  async maybeTriggerClaude(
    p: PendingApproval,
    doExport: (p: PendingApproval) => Promise<string | undefined>,
  ): Promise<SupervisionRecord | undefined> {
    if (!this.cfg.enabled) { return undefined; }
    if (this.triggeredClaude.has(p.requestId)) { return undefined; }
    this.triggeredClaude.add(p.requestId); // mark before async work to avoid a double-trigger race

    let exportedId: string | undefined;
    try {
      exportedId = await doExport(p);
    } catch (err) {
      this.triggeredClaude.delete(p.requestId); // export failed → allow a retry next sweep
      this.log(`supervision(claude): export failed for ${p.requestId}: ${String(err)}`);
      return undefined;
    }
    if (!exportedId) {
      this.triggeredClaude.delete(p.requestId); // no session resolved → retry next sweep
      this.log(
        `supervision(claude): no target session for ${p.toolName} req=${p.requestId}; will retry`);
      return undefined;
    }
    return this.superviseExported(exportedId, `${p.toolName} req=${p.requestId}`, () => {
      this.triggeredClaude.delete(p.requestId);
    });
  }

  /** Classify an already-exported session. On failure the dedup mark is released for a retry. */
  private async superviseExported(
    sessionId: string, label: string, releaseDedup: () => void,
  ): Promise<SupervisionRecord | undefined> {
    try {
      const record = await this.orch.supervise(sessionId, {
        user: this.cfg.user, project: this.cfg.project, team: this.cfg.team,
      });
      this.log(
        `supervision: ${sessionId} (${label}) -> ${record.state}`
        + `${record.error ? ` error=${record.error}` : ''}`,
      );
      return record;
    } catch (err) {
      releaseDedup(); // an unexpected failure must not permanently swallow this prompt
      this.log(`supervision: supervise failed for ${sessionId}: ${String(err)}`);
      return undefined;
    }
  }

  dispose(): void {
    this.stopped = true;
    if (this.pollTimer !== undefined) { clearTimeout(this.pollTimer); this.pollTimer = undefined; }
    this.triggered.clear();
    this.triggeredClaude.clear();
  }
}
