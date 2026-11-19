import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const electronStub = new URL("./helpers/electron-stub.mjs", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "electron" ? { url: electronStub, shortCircuit: true } : nextResolve(specifier, context);
  }
});
const { executePlan, getAiSharing, getCommitDetail, getCommitFileDiff, getSelectionDiff, getSnapshot, getWorkingFileDiff, prepareOperation } =
  await import("../dist-electron/electron/git-service.js");

function repository(t) {
  const path = mkdtempSync(join(tmpdir(), "gitcat-incomplete-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const git = (args, input) => execFileSync("git", args, { cwd: path, input, encoding: "utf8", maxBuffer: 8_000_000 });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.com"]);
  writeFileSync(join(path, "work.txt"), "before\n");
  git(["add", "work.txt"]);
  git(["commit", "-qm", "Initial"]);
  const addIndexEntries = (count) => {
    const blob = git(["hash-object", "-w", "--stdin"], "content\n").trim();
    const entries = Array.from({ length: count }, (_, index) =>
      `100644 ${blob}\t${String(index).padStart(5, "0")}-${"a".repeat(145)}.txt\n`);
    git(["update-index", "--index-info"], entries.join(""));
  };
  return { path, git, addIndexEntries };
}

test("a large Git status cannot produce a partial repository snapshot or authorize an operation", async (t) => {
  const { path, git, addIndexEntries } = repository(t);
  const head = git(["rev-parse", "HEAD"]).trim();
  const plan = await prepareOperation(path, "create_branch", { name: "reviewed-branch", from: head }, "en");
  addIndexEntries(15_000);
  const status = git(["status", "--short", "--untracked-files=all", "-z"]);
  assert.ok(status.length > 2_000_000);
  await assert.rejects(getSnapshot(path), /Git output exceeded the read limit/);
  await assert.rejects(executePlan(path, plan, "en"), /Git output exceeded the read limit/);
  assert.equal(git(["rev-parse", "HEAD"]).trim(), head);
  assert.equal(git(["branch", "--list", "reviewed-branch"]), "");
});

test("a complete status cannot hide an incomplete index listing", async (t) => {
  const { path, git, addIndexEntries } = repository(t);
  addIndexEntries(11_000);
  assert.ok(git(["status", "--short", "-z"]).length < 2_000_000);
  assert.ok(git(["ls-files", "--stage", "-z"]).length > 2_000_000);
  await assert.rejects(getSnapshot(path), /Git output exceeded the read limit/);
});

test("large text diffs remain available as explicitly shortened previews", async (t) => {
  const { path, git } = repository(t);
  writeFileSync(join(path, "work.txt"), "new line\n".repeat(250_000));
  assert.ok(git(["diff", "HEAD", "--", "work.txt"]).length > 2_000_000);
  await assert.rejects(getAiSharing(path, "description", ["work.txt"], "en"), /Git output exceeded the read limit/);
  const previews = [await getWorkingFileDiff(path, "work.txt"), await getSelectionDiff(path, ["work.txt"], "en")];
  git(["add", "work.txt"]);
  git(["commit", "-qm", "Large change"]);
  const head = git(["rev-parse", "HEAD"]).trim();
  previews.push(await getCommitDetail(path, head), await getCommitFileDiff(path, head, "work.txt"));
  for (const preview of previews) {
    assert.equal(preview.truncated, true);
    assert.match(preview.diff, /^diff --git/);
    assert.match(preview.diff.slice(-100), /\[diff recortado\]$/);
  }
});
