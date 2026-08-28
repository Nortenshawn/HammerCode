import { createTwoFilesPatch } from "diff";
import type { FileChange } from "./contracts";

const MAX_REVIEW_DIFF_CHARS = 200_000;

export interface FileReview {
  path: string;
  kind: "create" | "modify" | "delete";
  diff: string;
  additions: number;
  deletions: number;
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

function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
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
    const counts = countDiffLines(fullDiff);
    reviews.push({
      path: item.path,
      kind,
      diff: fullDiff.slice(0, MAX_REVIEW_DIFF_CHARS),
      additions: counts.additions,
      deletions: counts.deletions,
      truncated: fullDiff.length > MAX_REVIEW_DIFF_CHARS,
      appliedChangeCount: item.applied.length,
      revertedChangeCount: item.revertedCount,
      latestChangeId: latest.id,
    });
  }
  return reviews.sort((left, right) => left.path.localeCompare(right.path));
}
