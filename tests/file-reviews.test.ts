import { describe, expect, it } from "vitest";
import { hashText } from "../src/core/file-state";
import { buildFileReviews } from "../src/shared/file-reviews";
import type { FileChange } from "../src/shared/contracts";

function change(id: string, before: string, after: string, status: FileChange["status"]): FileChange {
  return {
    id,
    turnId: "turn_1",
    toolCallId: `call_${id}`,
    path: "src/a.ts",
    kind: "modify",
    beforeContent: before,
    afterContent: after,
    beforeHash: hashText(before),
    afterHash: hashText(after),
    patch: "individual",
    status,
    appliedAt: `2026-08-28T00:00:0${id.at(-1)}.000Z`,
  };
}

describe("cumulative file reviews", () => {
  it("builds one cumulative diff across multiple writes", () => {
    const reviews = buildFileReviews([
      change("change_1", "one\n", "two\n", "applied"),
      change("change_2", "two\n", "three\n", "applied"),
    ]);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ path: "src/a.ts", additions: 1, deletions: 1, appliedChangeCount: 2, latestChangeId: "change_2" });
    expect(reviews[0].diff).toContain("-one");
    expect(reviews[0].diff).toContain("+three");
  });

  it("removes reverted mutations from the cumulative state", () => {
    const reviews = buildFileReviews([
      change("change_1", "one\n", "two\n", "applied"),
      change("change_2", "two\n", "three\n", "reverted"),
    ]);
    expect(reviews[0]).toMatchObject({ additions: 1, deletions: 1, appliedChangeCount: 1, revertedChangeCount: 1, latestChangeId: "change_1" });
    expect(reviews[0].diff).toContain("+two");
    expect(reviews[0].diff).not.toContain("+three");
  });

  it("counts changed source lines that resemble unified diff headers", () => {
    const reviews = buildFileReviews([
      change("change_1", "--old marker\n", "++new marker\n", "applied"),
    ]);
    expect(reviews[0]).toMatchObject({ additions: 1, deletions: 1 });
    expect(reviews[0].diff).toContain("---old marker");
    expect(reviews[0].diff).toContain("+++new marker");
  });
});
