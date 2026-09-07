import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export function descendantGroups(snapshot: string, root: number): number[] {
  const rows = snapshot
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
  const descendants = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parent] of rows) {
      if (pid && parent && descendants.has(parent) && !descendants.has(pid)) {
        descendants.add(pid);
        changed = true;
      }
    }
  }
  // Only signal groups whose leader belongs to this process tree, never the caller's group.
  return [
    ...new Set(
      rows
        .filter(
          ([pid, , group]) =>
            pid && group && descendants.has(pid) && descendants.has(group),
        )
        .map(([, , group]) => group!),
    ),
  ];
}

export async function ownedGroups(root: number): Promise<number[]> {
  const { stdout } = await exec("/bin/ps", ["-axo", "pid=,ppid=,pgid="], {
    timeout: 2000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return descendantGroups(stdout, root);
}

export function groupExists(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

export function signalGroups(groups: number[], signal: NodeJS.Signals): void {
  for (const group of groups) {
    try {
      process.kill(-group, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}
