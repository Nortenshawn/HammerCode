import path from "node:path";
import type { WorkspaceWriteLease, WorkspaceWriteLeasePort } from "./types";
import { HammerCodeError } from "./types";

function normalizeLeasePath(input: string): string {
  if (!input || input.includes("\0") || path.isAbsolute(input)) {
    throw new HammerCodeError("写入租约路径必须是工作区内的相对路径", "INVALID_LEASE_PATH", true);
  }
  const normalized = path.normalize(input).replaceAll(path.sep, "/");
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new HammerCodeError("写入租约不能越过工作区", "INVALID_LEASE_PATH", true);
  }
  return normalized;
}

export class WorkspaceWriteLeaseManager implements WorkspaceWriteLeasePort {
  private readonly leases = new Map<string, WorkspaceWriteLease>();

  acquire(inputPath: string, ownerId: string, now: Date): WorkspaceWriteLease {
    const leasePath = normalizeLeasePath(inputPath);
    const existing = this.leases.get(leasePath);
    if (existing && existing.ownerId !== ownerId) {
      throw new HammerCodeError(
        `${leasePath} 正由另一个写入者占用`,
        "WRITE_LEASE_CONFLICT",
        true,
      );
    }
    if (existing) return { ...existing };
    const lease = { path: leasePath, ownerId, acquiredAt: now.toISOString() };
    this.leases.set(leasePath, lease);
    return { ...lease };
  }

  release(inputPath: string, ownerId: string): void {
    const leasePath = normalizeLeasePath(inputPath);
    if (this.leases.get(leasePath)?.ownerId === ownerId) this.leases.delete(leasePath);
  }

  releaseOwner(ownerId: string): void {
    for (const [leasePath, lease] of this.leases) {
      if (lease.ownerId === ownerId) this.leases.delete(leasePath);
    }
  }

  snapshot(): WorkspaceWriteLease[] {
    return [...this.leases.values()].map((lease) => ({ ...lease }));
  }
}
