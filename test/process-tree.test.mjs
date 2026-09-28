import test from "node:test";
import assert from "node:assert/strict";
import { signalProcessTree } from "../dist-electron/electron/process-tree.js";

test("Mac and Linux cancellation still signal the group, including escalation after the parent exits", (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const sent = [];
  t.mock.method(process, "kill", (pid, signal) => { sent.push([pid, signal]); return true; });
  t.after(() => Object.defineProperty(process, "platform", platform));
  for (const value of ["darwin", "linux"]) {
    Object.defineProperty(process, "platform", { value });
    const child = { pid: 12345, exitCode: null, signalCode: null, kill: () => assert.fail("the whole group should receive the signal") };
    signalProcessTree(child, "SIGTERM");
    child.exitCode = 0;
    signalProcessTree(child, "SIGKILL");
  }
  assert.deepEqual(sent, [[-12345, "SIGTERM"], [-12345, "SIGKILL"], [-12345, "SIGTERM"], [-12345, "SIGKILL"]]);
});

test("a missing Unix group retains the direct-child fallback", (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  t.mock.method(process, "kill", () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
  t.after(() => Object.defineProperty(process, "platform", platform));
  Object.defineProperty(process, "platform", { value: "darwin" });
  const sent = [];
  signalProcessTree({ pid: 12345, kill: signal => sent.push(signal) }, "SIGTERM");
  assert.deepEqual(sent, ["SIGTERM"]);
});
