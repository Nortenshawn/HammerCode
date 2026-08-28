import { describe, expect, it } from "vitest";
import { WorkspaceWriteLeaseManager } from "../src/core/write-leases";

describe("workspace write leases", () => {
  it("allows one writer per normalized path and releases by owner", () => {
    const leases = new WorkspaceWriteLeaseManager();
    const now = new Date("2026-08-29T00:00:00.000Z");
    expect(leases.acquire("src/../src/app.ts", "writer_a", now)).toMatchObject({
      path: "src/app.ts",
      ownerId: "writer_a",
    });
    expect(() => leases.acquire("src/app.ts", "writer_b", now)).toThrowError(/另一个写入者/);
    expect(leases.acquire("src/app.ts", "writer_a", now).ownerId).toBe("writer_a");
    leases.releaseOwner("writer_a");
    expect(leases.acquire("src/app.ts", "writer_b", now).ownerId).toBe("writer_b");
  });

  it("rejects absolute and escaping paths", () => {
    const leases = new WorkspaceWriteLeaseManager();
    const now = new Date("2026-08-29T00:00:00.000Z");
    expect(() => leases.acquire("/tmp/outside", "writer", now)).toThrowError(/相对路径/);
    expect(() => leases.acquire("../outside", "writer", now)).toThrowError(/越过工作区/);
  });
});
