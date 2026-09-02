import type { PermissionMode } from "../../shared/contracts";

export type PermissionSelectionAction = "confirm_full_access" | "persist";

export function permissionSelectionAction(nextPermission: PermissionMode): PermissionSelectionAction {
  return nextPermission === "full_access" ? "confirm_full_access" : "persist";
}
