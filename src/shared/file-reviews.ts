import { createTwoFilesPatch } from "diff";
import type { FileChange } from "./contracts";

const MAX_REVIEW_DIFF_CHARS = 200_000;

export interface FileReview {
  path: string;
  kind: "create" | "modify" | "delete";
  diff: string;
  truncated: boolean;
  appliedChangeCount: number;
  revertedChangeCount: number;
  latestChangeId: string;
}

interface FileReviewAccumulator {
  path: string;
  baseContent: string | null;
  currentContent: string | null;
  applied: FileChange[];
  revertedCount: number;
}

function sameContent(left: string | null, right: string | null): boolean {
  return left === right;
}

export function buildFileReviews(changes: FileChange[]): FileReview[] {
  const byPath = new Map<string, FileReviewAccumulator>();
  for (const change of changes) {
    let item = byPath.get(change.path);
    if (!item) {
      item = {
        path: change.path,
        baseContent: change.beforeContent,
        currentContent: change.beforeContent,
        applied: [],
        revertedCount: 0,
      };
      byPath.set(change.path, item);
    }
    if (change.status === "reverted") {
      item.revertedCount += 1;
      continue;
    }
    item.currentContent = change.afterContent;
    item.applied.push(change);
  }

  const reviews: FileReview[] = [];
  for (const item of byPath.values()) {
    const latest = item.applied.at(-1);
    if (!latest || sameContent(item.baseContent, item.currentContent)) continue;
    const kind =
      item.baseContent === null
        ? "create"
        : item.currentContent === null
          ? "delete"
          : "modify";
    const fullDiff = createTwoFilesPatch(
      item.baseContent === null ? "/dev/null" : `a/${item.path}`,
      item.currentContent === null ? "/dev/null" : `b/${item.path}`,
      item.baseContent ?? "",
      item.currentContent ?? "",
      "聊天开始前",
      "当前工作区",
      { context: 4 },
    );
    reviews.push({
      path: item.path,
      kind,
      diff: fullDiff.slice(0, MAX_REVIEW_DIFF_CHARS),
      truncated: fullDiff.length > MAX_REVIEW_DIFF_CHARS,
      appliedChangeCount: item.applied.length,
      revertedChangeCount: item.revertedCount,
      latestChangeId: latest.id,
    });
  }
  return reviews.sort((left, right) => left.path.localeCompare(right.path));
}
