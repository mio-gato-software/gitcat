import test from "node:test";
import assert from "node:assert/strict";
import cp, { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
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
  const git = (args, input) => execFileSync("git", args, { cwd: path, input, encoding: "utf8", maxBuffer: 16_000_000 });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.com"]);
  writeFileSync(join(path, "work.txt"), "before\n");
  git(["add", "work.txt"]);
  git(["commit", "-qm", "Initial"]);
  const addIndexEntries = (count, nameWidth = 145) => {
    const blob = git(["hash-object", "-w", "--stdin"], "content\n").trim();
    const entries = Array.from({ length: count }, (_, index) =>
      `100644 ${blob}\t${String(index).padStart(5, "0")}-${"a".repeat(nameWidth)}.txt\n`);
    git(["update-index", "--index-info"], entries.join(""));
    return { blob, entries };
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

test("a clean repository with 20,000 tracked files opens via streamed index reading and preserves integrity", async (t) => {
  const { path, git, addIndexEntries } = repository(t);
  const { entries } = addIndexEntries(20_000, 60);
  git(["commit", "-qm", "Track 20,000 files"]);
  const names = entries.map((line) => line.slice(line.indexOf("\t") + 1));
  git(["update-index", "--skip-worktree", "--stdin"], names.join(""));

  assert.equal(git(["status", "--short", "--untracked-files=all", "-z"]), "");
  assert.ok(git(["ls-files", "--stage", "-z"]).length > 2_000_000);

  const clean = await getSnapshot(path);
  assert.equal(clean.isDirty, false);
  assert.deepEqual(clean.changes, []);

  // Edits and staged index updates still change per-file versions and the full-index stateId.
  writeFileSync(join(path, "work.txt"), "edited\n");
  const dirty = await getSnapshot(path);
  assert.equal(dirty.isDirty, true);
  assert.equal(dirty.changes.length, 1);
  assert.equal(dirty.changes[0].path, "work.txt");
  const beforeStageVersion = dirty.changes[0].version;

  git(["add", "work.txt"]);
  const staged = await getSnapshot(path);
  assert.notEqual(staged.changes[0].version, beforeStageVersion);
  assert.notEqual(staged.stateId, dirty.stateId);

  // Even a change deep inside the 20,000-file index alters stateId.
  const otherBlob = git(["hash-object", "-w", "--stdin"], "updated\n").trim();
  const lastFile = names.at(-1).trim();
  git(["update-index", "--index-info"], `100644 ${otherBlob}\t${lastFile}\n`);
  const afterDeepIndexChange = await getSnapshot(path);
  assert.notEqual(afterDeepIndexChange.stateId, staged.stateId);
});

for (const variant of ["truncated-tail", "malformed-record", "non-zero-exit"]) {
  test(`an incomplete streamed index listing is rejected: ${variant}`, async (t) => {
    const { path, git } = repository(t);
    const validSample = git(["ls-files", "--stage", "-z"]);
    const nativeSpawn = cp.spawn;
    const script = {
      "truncated-tail": `process.stdout.write(${JSON.stringify(validSample + "100644 deadbeef")});`,
      "malformed-record": `process.stdout.write(${JSON.stringify(validSample + "100644 badheader\\0")});`,
      "non-zero-exit": `process.stdout.write(${JSON.stringify(validSample)}); process.stderr.write("fatal: index read failed\\n"); process.exit(128);`
    }[variant];

    t.mock.method(cp, "spawn", (exe, args, options) => {
      if (Array.isArray(args) && args.includes("ls-files") && args.includes("--stage")) {
        return nativeSpawn(process.execPath, ["-e", script], options);
      }
      return nativeSpawn(exe, args, options);
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

    await assert.rejects(
      getSnapshot(path),
      variant === "non-zero-exit" ? /index read failed/ : /incomplete index listing/
    );
  });
}

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
