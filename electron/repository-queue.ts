import { resolve } from "node:path";

const queues = new Map<string, Promise<unknown>>();

/**
 * One Git job per repository at a time. A background fetch moves remote-tracking refs, so it must
 * never interleave with a plan being prepared or executed: the plan would be checked against one
 * state and run against another. Jobs for different repositories still run side by side, and a job
 * that fails never blocks the ones queued behind it.
 */
export function exclusive<T>(cwd: string, task: () => Promise<T>): Promise<T> {
  const key = resolve(cwd);
  const run = (queues.get(key) ?? Promise.resolve()).then(task);
  const tail = run.then(() => undefined, () => undefined);
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}
