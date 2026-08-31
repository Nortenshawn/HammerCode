import type { SessionStatus, WorkspaceSummary } from "../../shared/contracts";

export const ACTIVE_MAIN_STATUSES: readonly SessionStatus[] = [
  "requesting",
  "awaiting_approval",
  "executing_tool",
];

function isActive(status: SessionStatus): boolean {
  return ACTIVE_MAIN_STATUSES.includes(status);
}

export interface MainRunUiState {
  activeCount: number;
  currentSessionRunning: boolean;
  workspaceHasRunningSession: boolean;
  anotherSessionInWorkspaceRunning: boolean;
  limitReached: boolean;
}

export function deriveMainRunUiState(
  workspaces: readonly WorkspaceSummary[],
  workspaceRoot: string | null,
  currentSessionId: string | null,
  maxConcurrent: number,
): MainRunUiState {
  const active = workspaces.flatMap((workspace) =>
    workspace.sessions
      .filter((session) => isActive(session.status))
      .map((session) => ({ workspaceRoot: workspace.root, sessionId: session.id })),
  );
  const currentSessionRunning = currentSessionId !== null && active.some(
    (session) => session.sessionId === currentSessionId,
  );
  const workspaceHasRunningSession = workspaceRoot !== null && active.some(
    (session) => session.workspaceRoot === workspaceRoot,
  );
  return {
    activeCount: active.length,
    currentSessionRunning,
    workspaceHasRunningSession,
    anotherSessionInWorkspaceRunning: workspaceHasRunningSession && !currentSessionRunning,
    limitReached: active.length >= maxConcurrent,
  };
}
