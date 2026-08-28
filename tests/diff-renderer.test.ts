import { describe, expect, it } from "vitest";
import { renderDiffLines } from "../src/renderer/src/diff-renderer";

describe("diff presentation", () => {
  it("renders source lines while hiding patch transport markers", () => {
    const lines = renderDiffLines([
      "Index: notes.txt",
      "===================================================================",
      "--- notes.txt\tbefore",
      "+++ notes.txt\tafter",
      "@@ -0,0 +1,3 @@",
      "+第一行",
      "+第二行很长但应交给界面自动换行",
      "+第三行",
      "\\ No newline at end of file",
    ].join("\n"));

    expect(lines).toEqual([
      { kind: "addition", text: "第一行", newLine: 1 },
      { kind: "addition", text: "第二行很长但应交给界面自动换行", newLine: 2 },
      { kind: "addition", text: "第三行", newLine: 3 },
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/@@|===|Index:|---|\+\+\+/);
  });

  it("keeps old and new line counters across a normal hunk", () => {
    const lines = renderDiffLines("@@ -4,2 +4,2 @@\n unchanged\n-old\n+new");
    expect(lines).toEqual([
      { kind: "context", text: "unchanged", oldLine: 4, newLine: 4 },
      { kind: "deletion", text: "old", oldLine: 5 },
      { kind: "addition", text: "new", newLine: 5 },
    ]);
  });
});
