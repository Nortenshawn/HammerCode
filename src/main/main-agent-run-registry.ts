import type { AgentRunner } from "../core/agent-runner";
import { HammerCodeError } from "../core/types";
import type {
  AgentSession,
  ModelRef,
  ModelTier,
  PermissionMode,
} from "../shared/contracts";
import type { PendingApprovalGateway } from "./approval-gateway";

export interface MainAgentRunBudgetSnapshot {
  readonly maxRounds: number;
  readonly maxToolCalls: number;
  readonly maxRunTimeMs: number;
  readonly maxModelRetries: number;
  readonly maxOutputTokens: number;
  readonly contextTokenBudget: number;
}

export interface MainAgentRunExecutionSnapshot {
  readonly modelTier: ModelTier;
  readonly modelRef: ModelRef;
  readonly modelName: string;
  readonly permissionMode: PermissionMode;
  readonly budget: MainAgentRunBudgetSnapshot;
}

export interface MainAgentRun {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly runner: AgentRunner;
  readonly approvals: PendingApprovalGateway;
  readonly abortController: AbortController;
  readonly execution: MainAgentRunExecutionSnapshot;
  currentSession: AgentSession;
}

export interface MainAgentRunReservation {
  readonly id: number;
  readonly workspaceRoot: string;
}

export class MainAgentRunRegistry {
  private readonly runs = new Map<string, MainAgentRun>();
  private readonly workspaceOwners = new Map<string, string>();
  private readonly reservations = new Map<number, string>();
  private readonly reservedWorkspaces = new Map<string, number>();
  private nextReservationId = 1;

  constructor(readonly maxConcurrent: number) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 3) {
      throw new HammerCodeError(
        "主 Agent 并发上限必须在 1 到 3 之间",
        "INVALID_MAIN_AGENT_LIMIT",
      );
    }
  }

  get activeCount(): number {
    return this.runs.size;
  }

  get occupiedCount(): number {
    return this.runs.size + this.reservations.size;
  }

  get sessionIds(): string[] {
    return [...this.runs.keys()];
  }

  reserve(workspaceRoot: string): MainAgentRunReservation {
    if (this.workspaceOwners.has(workspaceRoot) || this.reservedWorkspaces.has(workspaceRoot)) {
      throw new HammerCodeError(
        "当前项目已有主任务运行；同一项目需要 Git worktree 隔离后才能并行。",
        "WORKSPACE_MAIN_AGENT_BUSY",
        true,
      );
    }
    if (this.occupiedCount >= this.maxConcurrent) {
      throw new HammerCodeError(
        `最多同时运行 ${this.maxConcurrent} 个主任务，请等待其中一个结束。`,
        "MAIN_AGENT_CONCURRENCY_LIMIT",
        true,
      );
    }
    const reservation: MainAgentRunReservation = {
      id: this.nextReservationId++,
      workspaceRoot,
    };
    this.reservations.set(reservation.id, workspaceRoot);
    this.reservedWorkspaces.set(workspaceRoot, reservation.id);
    return reservation;
  }

  canonicalizeReservation(
    reservation: MainAgentRunReservation,
    canonicalWorkspaceRoot: string,
  ): MainAgentRunReservation {
    const currentRoot = this.reservations.get(reservation.id);
    if (currentRoot !== reservation.workspaceRoot) {
      throw new HammerCodeError("主任务启动预留已失效", "MAIN_AGENT_RESERVATION_INVALID");
    }
    if (currentRoot === canonicalWorkspaceRoot) return reservation;
    const otherReservation = this.reservedWorkspaces.get(canonicalWorkspaceRoot);
    if (
      this.workspaceOwners.has(canonicalWorkspaceRoot) ||
      (otherReservation !== undefined && otherReservation !== reservation.id)
    ) {
      this.releaseReservation(reservation);
      throw new HammerCodeError(
        "当前项目已有主任务运行；同一项目需要 Git worktree 隔离后才能并行。",
        "WORKSPACE_MAIN_AGENT_BUSY",
        true,
      );
    }
    if (this.reservedWorkspaces.get(currentRoot) === reservation.id) {
      this.reservedWorkspaces.delete(currentRoot);
    }
    this.reservations.set(reservation.id, canonicalWorkspaceRoot);
    this.reservedWorkspaces.set(canonicalWorkspaceRoot, reservation.id);
    return { id: reservation.id, workspaceRoot: canonicalWorkspaceRoot };
  }

  attach(reservation: MainAgentRunReservation, run: MainAgentRun): void {
    const workspaceRoot = this.reservations.get(reservation.id);
    if (workspaceRoot !== reservation.workspaceRoot || workspaceRoot !== run.workspaceRoot) {
      throw new HammerCodeError("主任务启动预留已失效", "MAIN_AGENT_RESERVATION_INVALID");
    }
    if (run.currentSession.id !== run.sessionId) {
      throw new HammerCodeError("主任务运行项的会话快照不一致", "MAIN_AGENT_SESSION_MISMATCH");
    }
    if (this.runs.has(run.sessionId)) {
      throw new HammerCodeError("这条聊天已经有主任务运行", "MAIN_AGENT_SESSION_DUPLICATE", true);
    }
    this.releaseReservation(reservation);
    this.runs.set(run.sessionId, run);
    this.workspaceOwners.set(run.workspaceRoot, run.sessionId);
  }

  releaseReservation(reservation: MainAgentRunReservation): void {
    const workspaceRoot = this.reservations.get(reservation.id);
    if (workspaceRoot === undefined) return;
    this.reservations.delete(reservation.id);
    if (this.reservedWorkspaces.get(workspaceRoot) === reservation.id) {
      this.reservedWorkspaces.delete(workspaceRoot);
    }
  }

  get(sessionId: string): MainAgentRun | undefined {
    return this.runs.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.runs.has(sessionId);
  }

  workspaceSessionId(workspaceRoot: string): string | undefined {
    return this.workspaceOwners.get(workspaceRoot);
  }

  isWorkspaceOccupied(workspaceRoot: string): boolean {
    return this.workspaceOwners.has(workspaceRoot) || this.reservedWorkspaces.has(workspaceRoot);
  }

  updateSession(session: AgentSession): void {
    const run = this.runs.get(session.id);
    if (!run) return;
    if (run.workspaceRoot !== session.workspaceRoot) {
      throw new HammerCodeError("运行中的聊天不能改变绑定工作区", "MAIN_AGENT_WORKSPACE_CHANGED");
    }
    run.currentSession = session;
  }

  resolveApproval(sessionId: string, approvalId: string, approved: boolean): void {
    const run = this.require(sessionId);
    if (run.currentSession.pendingApproval?.id !== approvalId) {
      throw new HammerCodeError(
        "审批不属于这条聊天或已经失效",
        "APPROVAL_SESSION_MISMATCH",
        true,
      );
    }
    run.approvals.resolve(approvalId, approved);
  }

  cancel(sessionId: string, detail: string): void {
    const run = this.require(sessionId);
    if (!run.abortController.signal.aborted) {
      run.abortController.abort(new DOMException(detail, "AbortError"));
    }
    run.runner.cancel(detail);
    run.approvals.cancel();
  }

  cancelAll(detail: string): void {
    for (const sessionId of this.sessionIds) this.cancel(sessionId, detail);
  }

  finish(sessionId: string): MainAgentRun | undefined {
    const run = this.runs.get(sessionId);
    if (!run) return undefined;
    this.runs.delete(sessionId);
    if (this.workspaceOwners.get(run.workspaceRoot) === sessionId) {
      this.workspaceOwners.delete(run.workspaceRoot);
    }
    return run;
  }

  private require(sessionId: string): MainAgentRun {
    const run = this.runs.get(sessionId);
    if (!run) {
      throw new HammerCodeError("这条聊天当前没有运行中的主任务", "MAIN_AGENT_NOT_RUNNING", true);
    }
    return run;
  }
}
