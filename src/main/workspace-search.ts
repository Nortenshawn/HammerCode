import { readdir } from "node:fs/promises";
import path from "node:path";
import { WorkspaceBoundary } from "../core/security/path-boundary";
import type { WorkspaceEntry } from "../shared/contracts";

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "release", "coverage"]);

export async function searchWorkspace(
  boundary: WorkspaceBoundary,
  rawQuery: string,
): Promise<WorkspaceEntry[]> {
  const query = rawQuery.trim().toLocaleLowerCase();
  const results: WorkspaceEntry[] = [];
  let scanned = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 8 || scanned >= 5_000 || results.length >= 80) return;
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (scanned >= 5_000 || results.length >= 80) return;
      scanned += 1;
      if (IGNORED_DIRECTORIES.has(child.name) || child.isSymbolicLink()) continue;
      const absolute = path.join(directory, child.name);
      const relative = boundary.relative(absolute);
      if (!query || relative.toLocaleLowerCase().includes(query)) {
        results.push({
          path: relative,
          name: child.name,
          kind: child.isDirectory() ? "directory" : "file",
        });
      }
      if (child.isDirectory()) await walk(absolute, depth + 1);
    }
  };
  await walk(boundary.root, 0);
  return results.sort((left, right) => {
    const leftStarts = left.path.toLocaleLowerCase().startsWith(query) ? 0 : 1;
    const rightStarts = right.path.toLocaleLowerCase().startsWith(query) ? 0 : 1;
    return leftStarts - rightStarts || left.path.localeCompare(right.path);
  }).slice(0, 60);
}
