export interface RenderedDiffLine {
  kind: "addition" | "deletion" | "context";
  text: string;
  oldLine?: number;
  newLine?: number;
}

export function renderDiffLines(diff: string): RenderedDiffLine[] {
  const rendered: RenderedDiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (match) {
        oldLine = Number(match[1]);
        newLine = Number(match[2]);
      }
      continue;
    }
    if (!inHunk || line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      rendered.push({ kind: "addition", text: line.slice(1), newLine });
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      rendered.push({ kind: "deletion", text: line.slice(1), oldLine });
      oldLine += 1;
      continue;
    }
    if (!line && rendered.length > 0) continue;
    rendered.push({
      kind: "context",
      text: line.startsWith(" ") ? line.slice(1) : line,
      oldLine,
      newLine,
    });
    oldLine += 1;
    newLine += 1;
  }
  return rendered;
}

