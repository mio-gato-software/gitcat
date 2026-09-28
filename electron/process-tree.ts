import { execFile, type ChildProcess } from "node:child_process";
import { join } from "node:path";

/** Signal a child started in its own group, including Git's transport helpers. */
export function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    // Killing Git first orphans git-remote-https/ssh and leaves their output pipes open.
    // Windows has no Unix process groups; taskkill must see the live parent to walk its tree.
    execFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
      ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 }, (error) => {
        if (error && child.exitCode === null && child.signalCode === null) child.kill(signal);
      });
    return;
  }
  try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
}
