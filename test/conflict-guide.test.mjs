import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const electronStub = pathToFileURL(join(root, "test/helpers/electron-stub.mjs")).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "electron" ? { url: electronStub, shortCircuit: true } : nextResolve(specifier, context);
  }
});
const service = await import(pathToFileURL(join(root, "dist-electron/electron/git-service.js")));
const guideModule = await import(pathToFileURL(join(root, "dist-electron/electron/conflict-guide.js")));

// No provider is configured in this file. Any request to one is a failure of the test.
let providerCalls = 0;
globalThis.fetch = async () => { providerCalls += 1; throw new Error("no provider in this test"); };

function repository() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "gitcat-guide-")));
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main", ".");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  const write = (file, content) => writeFileSync(join(repo, file), content);
  const read = (file) => readFileSync(join(repo, file), "utf8");
  const bytes = (file) => readFileSync(join(repo, file));
  const unmerged = () => git("ls-files", "-u");
  return { repo, git, write, read, bytes, unmerged, exists: (file) => existsSync(join(repo, file)) };
}

const png = (tag) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), Buffer.from(tag)]);

/** A merge of "otra" into main that stops on every shape of conflict at once. */
function mergeConflicts() {
  const r = repository();
  r.write("text.txt", "uno\ndos\ntres\n");
  r.write("gone-there.txt", "base\n");
  r.write("gone-here.txt", "base\n");
  writeFileSync(join(r.repo, "logo.png"), png("base"));
  r.git("add", "-A"); r.git("commit", "-qm", "base");
  r.git("switch", "-qc", "otra");
  r.write("text.txt", "uno\nDOS-suyo\ntres\n");
  r.git("rm", "-q", "gone-there.txt");
  r.write("gone-here.txt", "cambiado allí\n");
  r.write("both.txt", "creado allí\n");
  writeFileSync(join(r.repo, "logo.png"), png("theirs"));
  r.git("add", "-A"); r.git("commit", "-qm", "Cambios de la otra rama");
  r.git("switch", "-q", "main");
  r.write("text.txt", "uno\nDOS-mio\ntres\n");
  r.write("gone-there.txt", "cambiado aquí\n");
  r.git("rm", "-q", "gone-here.txt");
  r.write("both.txt", "creado aquí\n");
  writeFileSync(join(r.repo, "logo.png"), png("ours"));
  r.git("add", "-A"); r.git("commit", "-qm", "Cambios de main");
  try { r.git("merge", "otra"); } catch { /* the conflict is the point */ }
  return r;
}

const fileIn = (guide, path) => guide.files.find((file) => file.path === path);

test("a merge conflict is explained from the repository alone, with real branch names and supported choices", async () => {
  const r = mergeConflicts();
  const guide = await service.describeConflicts(r.repo, "en");
  assert.equal(providerCalls, 0, "describing conflicts never contacts a provider");
  assert.equal(guide.repoPath, r.repo);
  assert.equal(guide.operation, "merge");
  assert.equal(guide.remaining, 0);
  assert.deepEqual({ id: guide.sides.ours.id, role: guide.sides.ours.role, name: guide.sides.ours.name, subject: guide.sides.ours.commit?.subject },
    { id: "ours", role: "current_branch", name: "main", subject: "Cambios de main" });
  assert.deepEqual({ role: guide.sides.theirs.role, name: guide.sides.theirs.name, subject: guide.sides.theirs.commit?.subject },
    { role: "incoming_branch", name: "otra", subject: "Cambios de la otra rama" });

  const text = fileIn(guide, "text.txt");
  assert.equal(text.kind, "both-modified");
  assert.deepEqual(text.choices, ["ours", "theirs", "edited"]);
  assert.equal(text.ours.preview, "uno\nDOS-mio\ntres\n");
  assert.equal(text.theirs.preview, "uno\nDOS-suyo\ntres\n");
  assert.equal(text.working.markers, true);

  const added = fileIn(guide, "both.txt");
  assert.equal(added.kind, "both-added");
  assert.equal(added.base.present, false);
  assert.deepEqual(added.choices, ["ours", "theirs", "edited"]);

  const deletedThere = fileIn(guide, "gone-there.txt");
  assert.equal(deletedThere.kind, "deleted-by-them");
  assert.equal(deletedThere.theirs.present, false);
  assert.deepEqual(deletedThere.choices, ["ours", "delete", "edited"]);
  const deletedHere = fileIn(guide, "gone-here.txt");
  assert.equal(deletedHere.kind, "deleted-by-us");
  assert.deepEqual(deletedHere.choices, ["theirs", "delete", "edited"]);

  const binary = fileIn(guide, "logo.png");
  assert.equal(binary.binary, true);
  assert.equal(binary.ours.preview, undefined, "a binary side has no text preview");
  assert.deepEqual(binary.choices, ["ours", "theirs"], "a binary file is taken whole: no hand edit");

  assert.equal(guide.binding.operation.length, 64, "the guide is bound to the operation");

  const result = await service.applyConflictChoices(r.repo, guide, [
    { path: "text.txt", choice: "ours" },
    { path: "both.txt", choice: "theirs" },
    { path: "gone-there.txt", choice: "delete" },
    { path: "gone-here.txt", choice: "theirs" },
    { path: "logo.png", choice: "theirs" }
  ], "en");
  assert.equal(result.complete, true);
  assert.ok(result.outcomes.every((outcome) => outcome.status === "applied"));
  assert.equal(r.read("text.txt"), "uno\nDOS-mio\ntres\n");
  assert.equal(r.read("both.txt"), "creado allí\n");
  assert.equal(r.exists("gone-there.txt"), false, "keeping the deletion removes the file");
  assert.equal(r.read("gone-here.txt"), "cambiado allí\n");
  assert.deepEqual(r.bytes("logo.png"), png("theirs"));
  assert.equal(r.unmerged(), "");
  assert.deepEqual(result.snapshot.conflicts, []);
  r.git("-c", "core.editor=true", "merge", "--continue");
  assert.equal(r.git("status", "--porcelain"), "");
  assert.equal(providerCalls, 0);
});

test("choices a file's shape does not support are refused before anything is written", async () => {
  const r = mergeConflicts();
  const guide = await service.describeConflicts(r.repo, "en");
  const before = r.unmerged();
  await assert.rejects(service.applyConflictChoices(r.repo, guide, [{ path: "logo.png", choice: "edited" }], "en"), /does not apply to logo\.png/);
  await assert.rejects(service.applyConflictChoices(r.repo, guide, [{ path: "gone-here.txt", choice: "ours" }], "en"), /does not apply/);
  await assert.rejects(service.applyConflictChoices(r.repo, guide, [{ path: "nope.txt", choice: "ours" }], "en"), /not part of this review/);
  await assert.rejects(service.applyConflictChoices(r.repo, guide, [{ path: "text.txt", choice: "whatever" }], "en"), /invalid/);
  assert.equal(r.unmerged(), before);
});

test("a hand edit is marked resolved only once its conflict markers are gone", async () => {
  const r = mergeConflicts();
  const guide = await service.describeConflicts(r.repo, "en");
  const withMarkers = r.read("text.txt");
  const refused = await service.applyConflictChoices(r.repo, guide, [{ path: "text.txt", choice: "edited" }, { path: "both.txt", choice: "ours" }], "en");
  assert.equal(refused.complete, false);
  assert.equal(refused.stale, undefined);
  assert.deepEqual(refused.outcomes.map(({ path, status, reason }) => ({ path, status, reason })), [
    { path: "text.txt", status: "refused", reason: "markers" },
    { path: "both.txt", status: "not_applied", reason: undefined }
  ]);
  assert.equal(r.read("text.txt"), withMarkers);
  assert.match(r.unmerged(), /\tboth\.txt/, "nothing is written while one choice is refused");
  // The person edits the file themselves; the same guide still accepts the hand edit.
  r.write("text.txt", "uno\nDOS-mio y DOS-suyo\ntres\n");
  const done = await service.applyConflictChoices(r.repo, guide, [{ path: "text.txt", choice: "edited" }], "en");
  assert.equal(done.complete, true);
  assert.equal(r.read("text.txt"), "uno\nDOS-mio y DOS-suyo\ntres\n");
  assert.doesNotMatch(r.unmerged(), /\ttext\.txt/);
});

test("taking a side never overwrites an edit made after the versions were shown", async () => {
  const r = mergeConflicts();
  const guide = await service.describeConflicts(r.repo, "en");
  const edited = "uno\nlo estaba editando\ntres\n";
  r.write("text.txt", edited);
  const stagesBefore = r.unmerged();
  const result = await service.applyConflictChoices(r.repo, guide, [{ path: "both.txt", choice: "ours" }, { path: "text.txt", choice: "theirs" }], "en");
  assert.equal(result.complete, false);
  assert.equal(result.stale, "files");
  assert.deepEqual(result.outcomes.map(({ path, status }) => ({ path, status })), [
    { path: "both.txt", status: "not_applied" }, { path: "text.txt", status: "changed" }
  ]);
  assert.equal(r.read("text.txt"), edited, "the edit is kept");
  assert.equal(r.unmerged(), stagesBefore, "nothing else was settled either");
});

test("a different operation, or another repository, invalidates the guide", async () => {
  const r = mergeConflicts();
  const guide = await service.describeConflicts(r.repo, "en");
  const other = mergeConflicts();
  const elsewhere = await service.applyConflictChoices(other.repo, guide, [{ path: "text.txt", choice: "ours" }], "en");
  assert.equal(elsewhere.stale, "repository");
  assert.match(other.unmerged(), /\ttext\.txt/);
  r.git("merge", "--abort");
  r.git("switch", "-qc", "tercera", "otra");
  r.write("text.txt", "uno\nDOS-tercero\ntres\n");
  r.git("commit", "-qam", "tercer cambio");
  r.git("switch", "-q", "main");
  try { r.git("merge", "tercera"); } catch { /* the same file in conflict, but another operation */ }
  assert.match(r.unmerged(), /\ttext\.txt/);
  const result = await service.applyConflictChoices(r.repo, guide, [{ path: "text.txt", choice: "ours" }], "en");
  assert.equal(result.stale, "operation");
  assert.deepEqual(result.outcomes.map((outcome) => outcome.status), ["changed"]);
  assert.match(r.unmerged(), /\ttext\.txt/);
});

test("when Git refuses one file, the result says which were settled and the failed one is put back", async () => {
  const r = mergeConflicts();
  const guide = await service.describeConflicts(r.repo, "en");
  const before = r.read("both.txt");
  // A required clean filter that fails makes `git add` refuse only both.txt.
  r.git("config", "filter.roto.clean", "false");
  r.git("config", "filter.roto.required", "true");
  writeFileSync(join(r.repo, ".git/info/attributes"), "both.txt filter=roto\n");
  const result = await service.applyConflictChoices(r.repo, guide, [
    { path: "text.txt", choice: "theirs" }, { path: "both.txt", choice: "theirs" }, { path: "logo.png", choice: "ours" }
  ], "en");
  assert.equal(result.complete, false, "a partial application is never reported as complete");
  assert.equal(result.stale, undefined);
  assert.deepEqual(result.outcomes.map(({ path, status, restored }) => ({ path, status, restored })), [
    { path: "text.txt", status: "applied", restored: undefined },
    { path: "both.txt", status: "failed", restored: true },
    { path: "logo.png", status: "not_applied", restored: undefined }
  ]);
  assert.ok(result.outcomes[1].detail);
  assert.equal(r.read("text.txt"), "uno\nDOS-suyo\ntres\n");
  assert.equal(r.read("both.txt"), before, "the failed file is exactly as it was");
  assert.match(r.unmerged(), /\tboth\.txt/);
  assert.match(r.unmerged(), /\tlogo\.png/);
  assert.doesNotMatch(r.unmerged(), /\ttext\.txt/);
});

/** feature/x has two commits; main changed the same line, so the first replay stops. */
function rebaseConflict() {
  const r = repository();
  r.write("f.txt", "uno\ndos\ntres\n");
  r.git("add", "-A"); r.git("commit", "-qm", "base");
  r.git("switch", "-qc", "feature/x");
  r.write("f.txt", "uno\nDOS-mio\ntres\n");
  r.git("commit", "-qam", "Mi cambio en feature");
  r.write("g.txt", "otro\n");
  r.git("add", "-A"); r.git("commit", "-qm", "Segundo commit");
  r.git("switch", "-q", "main");
  r.write("f.txt", "uno\nDOS-main\ntres\n");
  r.git("commit", "-qam", "Cambio en main");
  r.git("switch", "-q", "feature/x");
  try { r.git("rebase", "main"); } catch { /* the conflict is the point */ }
  return r;
}

test("during a rebase the sides are named the right way round: main is ours, the replayed commit is theirs", async () => {
  const r = rebaseConflict();
  const guide = await service.describeConflicts(r.repo, "en");
  assert.equal(guide.operation, "rebase");
  assert.equal(guide.branch, "feature/x");
  assert.equal(guide.step, 1);
  assert.equal(guide.total, 2);
  assert.equal(guide.remaining, 1, "one more commit can still stop with its own conflicts");
  assert.equal(guide.sides.ours.role, "rebase_base");
  assert.equal(guide.sides.ours.name, "main", "the branch being rebased onto, not the one being rebased");
  assert.equal(guide.sides.ours.commit?.subject, "Cambio en main");
  assert.equal(guide.sides.theirs.role, "replayed_commit");
  assert.equal(guide.sides.theirs.name, "feature/x");
  assert.equal(guide.sides.theirs.commit?.subject, "Mi cambio en feature");
  const file = fileIn(guide, "f.txt");
  assert.equal(file.ours.preview, "uno\nDOS-main\ntres\n", "stage 2 holds main's version");
  assert.equal(file.theirs.preview, "uno\nDOS-mio\ntres\n", "stage 3 holds the replayed commit's version");

  // Keeping the replayed commit's version keeps the person's own work.
  const result = await service.applyConflictChoices(r.repo, guide, [{ path: "f.txt", choice: "theirs" }], "en");
  assert.equal(result.complete, true);
  assert.equal(r.read("f.txt"), "uno\nDOS-mio\ntres\n");
  // Continuing is explained with what is still to come.
  const plan = await service.prepareOperation(r.repo, "continue_operation", {}, "en");
  assert.ok(plan.effects.some((effect) => /Mi cambio en feature/.test(effect)), plan.effects.join(" | "));
  assert.ok(plan.effects.some((effect) => /1 more commit will be applied afterwards, and any of them can stop again/.test(effect)));
  const skip = await service.prepareOperation(r.repo, "skip_operation", {}, "en");
  assert.ok(skip.effects.some((effect) => /its changes will not be in the result/.test(effect)));
  const abort = await service.prepareOperation(r.repo, "abort_operation", {}, "en");
  assert.ok(abort.effects.some((effect) => /before it started\. Any resolutions made so far are discarded/.test(effect)));
  r.git("-c", "core.editor=true", "rebase", "--continue");
  assert.equal(r.git("log", "-1", "--format=%s").trim(), "Segundo commit");
});

test("a side choice during a rebase is bound to the guide it was made in", async () => {
  const r = rebaseConflict();
  const guide = await service.describeConflicts(r.repo, "en");
  r.write("f.txt", "uno\nmi arreglo a mano\ntres\n");
  const result = await service.applyConflictChoices(r.repo, guide, [{ path: "f.txt", choice: "ours" }], "en");
  assert.equal(result.stale, "files");
  assert.equal(r.read("f.txt"), "uno\nmi arreglo a mano\ntres\n");
  assert.match(r.unmerged(), /\tf\.txt/);
});

test("rename conflicts say which side renamed what, and offer only choices that fit", async () => {
  const r = repository();
  r.write("k.txt", "contenido\n");
  r.git("add", "-A"); r.git("commit", "-qm", "base");
  r.git("switch", "-qc", "otra");
  r.git("mv", "k.txt", "k-suyo.txt"); r.git("commit", "-qm", "renombrar allí");
  r.git("switch", "-q", "main");
  r.git("mv", "k.txt", "k-mio.txt"); r.git("commit", "-qm", "renombrar aquí");
  try { r.git("merge", "otra"); } catch { /* rename/rename */ }
  const guide = await service.describeConflicts(r.repo, "en");
  const original = fileIn(guide, "k.txt");
  assert.equal(original.kind, "both-deleted");
  assert.deepEqual(original.choices, ["delete"]);
  assert.deepEqual(original.renames.map(({ side, to }) => `${side}:${to}`).sort(), ["ours:k-mio.txt", "theirs:k-suyo.txt"]);
  const mine = fileIn(guide, "k-mio.txt");
  assert.deepEqual(mine.choices, ["ours", "delete", "edited"]);
  assert.deepEqual(mine.renames, [{ side: "ours", from: "k.txt", to: "k-mio.txt" }]);
  const theirs = fileIn(guide, "k-suyo.txt");
  assert.deepEqual(theirs.choices, ["theirs", "delete", "edited"]);
  const result = await service.applyConflictChoices(r.repo, guide, [
    { path: "k.txt", choice: "delete" }, { path: "k-mio.txt", choice: "ours" }, { path: "k-suyo.txt", choice: "delete" }
  ], "en");
  assert.equal(result.complete, true, JSON.stringify(result.outcomes));
  assert.equal(r.unmerged(), "");
  assert.equal(r.read("k-mio.txt"), "contenido\n");
  assert.equal(r.exists("k-suyo.txt"), false);
});

test("the resolver works with no provider at all, while the assistant's proposal stays optional", async () => {
  const r = mergeConflicts();
  const calls = providerCalls;
  await assert.rejects(service.proposeConflictResolution(r.repo, "en"), /needs a connected AI provider/);
  const guide = await service.describeConflicts(r.repo, "en");
  assert.equal(guide.files.length, 5);
  assert.equal(providerCalls, calls);
});

test("only a file in conflict inside the repository can be opened in an editor", async () => {
  const r = mergeConflicts();
  assert.equal(await service.conflictFileToOpen(r.repo, "text.txt", "en"), join(r.repo, "text.txt"));
  await assert.rejects(service.conflictFileToOpen(r.repo, "../outside.txt", "en"), /no longer in conflict/);
  execFileSync("rm", [join(r.repo, "gone-here.txt")]);
  await assert.rejects(service.conflictFileToOpen(r.repo, "gone-here.txt", "en"), /not on disk/);
  await service.applyConflictChoices(r.repo, await service.describeConflicts(r.repo, "en"), [{ path: "text.txt", choice: "ours" }], "en");
  await assert.rejects(service.conflictFileToOpen(r.repo, "text.txt", "en"), /no longer in conflict/);
});

test("the guide's rules read Git's facts, not guesses", () => {
  assert.deepEqual(guideModule.choicesFor({ ours: true, theirs: true, binary: false, working: true }), ["ours", "theirs", "edited"]);
  assert.deepEqual(guideModule.choicesFor({ ours: true, theirs: true, binary: true, working: true }), ["ours", "theirs"]);
  assert.deepEqual(guideModule.choicesFor({ ours: false, theirs: true, binary: false, working: false }), ["theirs", "delete"]);
  assert.deepEqual(guideModule.choicesFor({ ours: false, theirs: false, binary: false, working: false }), ["delete"]);
  assert.equal(guideModule.hasConflictMarkers("a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> otra\n"), true);
  assert.equal(guideModule.hasConflictMarkers("a\n||||||| base\n"), true);
  assert.equal(guideModule.hasConflictMarkers("Título\n=======\n"), false, "a Markdown underline alone is not a marker");
  assert.equal(guideModule.hasConflictMarkers("a == b\n<<<<<<<<<< not a marker\n"), false);
  assert.deepEqual(guideModule.sideRoles("rebase"), { ours: "rebase_base", theirs: "replayed_commit" });
  assert.deepEqual(guideModule.sideRoles("merge"), { ours: "current_branch", theirs: "incoming_branch" });
  assert.equal(guideModule.remainingSteps("rebase", { step: 2, total: 5 }), 3);
  assert.equal(guideModule.remainingSteps("cherry_pick", {}, "pick 1 a\npick 2 b\n# comment\npick 3 c\n"), 2);
  assert.equal(guideModule.remainingSteps("merge", {}), 0);
  assert.deepEqual(guideModule.parseRenames("R100\0a.txt\0b.txt\0M\0c.txt\0"), [{ from: "a.txt", to: "b.txt" }]);
  assert.equal(guideModule.commandFor("ours", new Set([1, 3])), "remove", "keeping a side that deleted the file removes it");
  assert.equal(guideModule.commandFor("theirs", new Set([1, 2, 3])), "checkout");
  assert.equal(guideModule.commandFor("edited", new Set([1, 2, 3])), "add");
  assert.equal(guideModule.opensSafely("/r/notes.md", "darwin"), true);
  assert.equal(guideModule.opensSafely("/r/src/app.js", "darwin"), true);
  assert.equal(guideModule.opensSafely("/r/Makefile", "darwin"), true);
  assert.equal(guideModule.opensSafely("/r/run.command", "darwin"), false, "a file the system would run is only revealed");
  assert.equal(guideModule.opensSafely("/r/setup.SH", "linux"), false);
  assert.equal(guideModule.opensSafely("C:\\r\\tool.js", "win32"), false);
  const parsed = guideModule.parseUnmerged("100644 abc 1\ta b.txt\u0000100644 def 3\ta b.txt\u0000");
  assert.deepEqual(parsed.get("a b.txt").map((entry) => entry.stage), [1, 3]);
});
