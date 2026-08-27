import type { ApprovalRequest } from "../shared/contracts";
import type { ApprovalGateway } from "../core/types";
import { HammerCodeError } from "../core/types";

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (approved: boolean) => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

export class PendingApprovalGateway implements ApprovalGateway {
  private pending: PendingApproval | null = null;

  request(request: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
    if (this.pending) {
      return Promise.reject(
        new HammerCodeError("已有审批正在等待处理", "APPROVAL_ALREADY_PENDING"),
      );
    }
    return new Promise<boolean>((resolve, reject) => {
      const onAbort = () => {
        this.pending = null;
        reject(new DOMException("审批等待已取消", "AbortError"));
      };
      this.pending = { request, resolve, reject, signal, onAbort };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  resolve(id: string, approved: boolean): void {
    if (!this.pending || this.pending.request.id !== id) {
      throw new HammerCodeError("审批已失效或不存在", "APPROVAL_NOT_FOUND", true);
    }
    const pending = this.pending;
    this.pending = null;
    pending.signal.removeEventListener("abort", pending.onAbort);
    pending.resolve(approved);
  }

  cancel(): void {
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = null;
    pending.signal.removeEventListener("abort", pending.onAbort);
    pending.reject(new DOMException("审批等待已取消", "AbortError"));
  }
}
