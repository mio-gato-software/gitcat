import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
registerHooks({ resolve(specifier, context, next) { return specifier === "electron" ? { url: pathToFileURL(join(root, "test/helpers/electron-stub.mjs")).href, shortCircuit: true } : next(specifier, context); } });
const { getSnapshot, loadHistory, prepareBranchDelivery, executePlan } = await import(pathToFileURL(join(root, "dist-electron/electron/git-service.js")));
const { inspectFolder, startTracking, previewClone, cloneRepository, classifyCloneFailure, isProtectedFolder } =
  await import(pathToFileURL(join(root, "dist-electron/electron/project-setup.js")));
const { parseCloneUrl, suggestedFolderName, folderNameProblem } = await import(pathToFileURL(join(root, "dist-electron/shared/clone-source.js")));

// Real folders throughout; the realpath keeps macOS's /var → /private/var link out of the comparisons.
function scratch(t, prefix = "gitcat-setup-") {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const identity = (cwd) => { git(cwd, "config", "user.name", "Test"); git(cwd, "config", "user.email", "test@example.com"); };
const listing = (path) => readdirSync(path).sort();

test("an ordinary folder is explained, previewed and only becomes a repository after confirming", async (t) => {
  const folder = join(scratch(t), "My notes");
  mkdirSync(join(folder, "chapters"), { recursive: true });
  mkdirSync(join(folder, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(folder, "readme.md"), "hello\n");
  writeFileSync(join(folder, "chapters", "one.md"), "one\n");
  writeFileSync(join(folder, ".env"), "TOKEN=abc\n");
  writeFileSync(join(folder, ".DS_Store"), "x");
  writeFileSync(join(folder, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  const before = listing(folder);

  const inspection = await inspectFolder(folder);
  assert.equal(inspection.kind, "folder");
  const preview = inspection.preview;
  assert.equal(preview.path, folder);
  assert.equal(preview.name, "My notes");
  assert.equal(preview.files, 5, "every file that the first save would list");
  assert.equal(preview.filesCapped, false);
  assert.equal(preview.hasGitignore, false);
  assert.equal(preview.blocked, undefined);
  assert.match(preview.branch, /^[\w./-]+$/);
  assert.deepEqual(preview.suggestions.map((item) => item.pattern).sort(), [".DS_Store", ".env", "node_modules/"]);
  assert.deepEqual(listing(folder), before, "previewing writes nothing, not even a .gitignore");

  const started = await startTracking(folder, { branch: preview.branch });
  assert.equal(started.status, "started");
  assert.equal(started.root, folder);
  assert.deepEqual(listing(folder), [...before, ".git"].sort(), "only .git was added");
  assert.equal(readFileSync(join(folder, "readme.md"), "utf8"), "hello\n", "files are left as they were");

  const snapshot = await getSnapshot(folder);
  assert.equal(snapshot.head, "", "no saved version yet");
  assert.equal(snapshot.currentBranch, preview.branch);
  assert.deepEqual(snapshot.commits, []);
  assert.equal(snapshot.changes.length, 5, "all files are listed as ready for the first save");
  assert.ok(snapshot.changes.every((change) => change.code === "??"));
  assert.deepEqual(await loadHistory(folder, { scope: "all" }), { commits: [], hasMore: false, scope: "all", branch: undefined });

  // The first save goes through the same reviewed flow as any other.
  identity(folder);
  const plan = await prepareBranchDelivery(folder, { stateId: snapshot.stateId, message: "First save", mergeToDefault: false, selection: snapshot.changes.filter((change) => change.path === "readme.md").map((change) => ({ path: change.path, version: change.version })) }, "en");
  assert.equal(plan.requiresConfirmation, true);
  const result = await executePlan(folder, plan, "en");
  assert.equal(result.error, undefined);
  assert.equal(git(folder, "show", "HEAD:readme.md"), "hello");
  assert.equal(result.snapshot.changes.length, 4, "the rest waits for a later save");

  // A second start on the same folder is refused as already a repository, without running init again.
  const again = await startTracking(folder, { branch: preview.branch });
  assert.equal(again.status, "changed");
  assert.equal(again.inspection.kind, "repository");
});

test("the person's init.defaultBranch names the first branch", async (t) => {
  const home = scratch(t, "gitcat-home-");
  const folder = join(home, "project");
  mkdirSync(folder);
  writeFileSync(join(folder, "a.txt"), "a\n");
  writeFileSync(join(home, ".gitconfig"), "[init]\n\tdefaultBranch = trunk\n");
  const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
  Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), GIT_CONFIG_NOSYSTEM: "1" });
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const inspection = await inspectFolder(folder);
  assert.equal(inspection.preview.branch, "trunk");
  const started = await startTracking(folder, { branch: "trunk" });
  assert.equal(started.status, "started");
  assert.equal(git(folder, "symbolic-ref", "--short", "HEAD"), "trunk");
  // A preview that promised another name is stale: nothing is written against it.
  const other = join(home, "other");
  mkdirSync(other);
  const stale = await startTracking(other, { branch: "main" });
  assert.equal(stale.status, "changed");
  assert.equal(existsSync(join(other, ".git")), false);
});

test("folders inside a repository, broken repositories and whole home folders are not started", async (t) => {
  const base = scratch(t);
  const parent = join(base, "parent");
  mkdirSync(join(parent, "src", "deep"), { recursive: true });
  git(parent, "init", "-q", "-b", "main");
  const inside = await inspectFolder(join(parent, "src", "deep"));
  assert.equal(inside.kind, "inside_repository");
  assert.equal(inside.root, parent);
  assert.equal((await inspectFolder(parent)).kind, "repository");
  const nested = await startTracking(join(parent, "src"), { branch: "main" });
  assert.equal(nested.status, "changed");
  assert.equal(existsSync(join(parent, "src", ".git")), false, "no repository is nested inside another");

  const broken = join(base, "broken");
  mkdirSync(join(broken, ".git"), { recursive: true });
  writeFileSync(join(broken, "file.txt"), "keep\n");
  const brokenInspection = await inspectFolder(broken);
  assert.equal(brokenInspection.kind, "folder");
  assert.equal(brokenInspection.preview.blocked, "broken_repository");
  assert.equal((await startTracking(broken, { branch: "main" })).status, "changed");

  const home = join(base, "home", "someone");
  mkdirSync(home, { recursive: true });
  assert.equal(isProtectedFolder(home, home), true);
  assert.equal(isProtectedFolder(join(base, "home"), home), true, "the folder of every home folder");
  assert.equal(isProtectedFolder("/", home), true);
  assert.equal(isProtectedFolder(join(home, "Documents"), home), false);
  const homeInspection = await inspectFolder(home, { home });
  assert.equal(homeInspection.preview.blocked, "protected");
  assert.equal((await startTracking(home, { home, branch: "main" }, { home })).status, "changed");
  assert.equal(existsSync(join(home, ".git")), false);

  const missing = await inspectFolder(join(base, "nowhere"));
  assert.deepEqual([missing.kind, missing.problem], ["invalid", "missing"]);
  writeFileSync(join(base, "plain.txt"), "x");
  assert.equal((await inspectFolder(join(base, "plain.txt"))).problem, "not_folder");
});

test("clone addresses are checked on this Mac before Git runs", () => {
  const ok = (url) => { const check = parseCloneUrl(url); assert.equal(check.ok, true, `${url} is accepted`); return check.source; };
  const refused = (url, problem) => { const check = parseCloneUrl(url); assert.equal(check.ok, false, `${url} is refused`); assert.equal(check.problem, problem, url); };
  assert.deepEqual(ok("https://github.com/octo/hello-world.git"), { url: "https://github.com/octo/hello-world.git", protocol: "https", host: "github.com", path: "octo/hello-world.git" });
  assert.equal(ok("  git@github.com:octo/hello.git ").protocol, "ssh");
  assert.equal(ok("ssh://git@gitlab.example.com:2222/group/app.git").host, "gitlab.example.com");
  assert.equal(ok("https://user@bitbucket.org/team/repo").host, "bitbucket.org");
  assert.equal(ok("work-github:team/repo.git").host, "work-github", "ssh aliases");
  refused("", "empty");
  refused("https://github.com/octo/hello world", "spaces");
  refused("https://github.com/octo/x\n--upload-pack=touch", "spaces");
  refused("--upload-pack=touch", "option");
  refused("-oProxyCommand=evil", "option");
  refused("ssh://-oProxyCommand=evil/repo", "option");
  refused("git@-oProxyCommand=evil:repo", "option");
  refused("git@github.com:-u/repo", "option");
  refused("ext::sh -c touch% /tmp/pwned", "spaces");
  refused("ext::sh", "transport_helper");
  refused("fd::17", "transport_helper");
  refused("github.com::octo/x", "transport_helper");
  refused("file:///etc", "local");
  refused("/Users/someone/repo", "local");
  refused("./repo", "local");
  refused("../repo", "local");
  refused("~/repo", "local");
  refused("C:\\repos\\app", "local");
  refused("http://github.com/octo/x.git", "insecure");
  refused("git://github.com/octo/x.git", "insecure");
  refused("ftp://example.com/x.git", "unsupported");
  refused("https://user:secret-token@github.com/octo/x.git", "credentials");
  refused("https://github.com", "malformed");
  refused("https://github.com/octo/x?ref=main", "malformed");
  refused("github.com/octo/x", "malformed");
  refused("x".repeat(1200), "too_long");
  assert.equal(suggestedFolderName("https://github.com/octo/hello-world.git"), "hello-world");
  assert.equal(suggestedFolderName("git@github.com:octo/Notes.git/"), "Notes");
  assert.equal(suggestedFolderName("https://example.com/"), "repository");
  assert.equal(folderNameProblem("app"), undefined);
  assert.equal(folderNameProblem("../app"), "separator");
  assert.equal(folderNameProblem(".."), "reserved");
  assert.equal(folderNameProblem("  "), "empty");
});

test("a clone preview names the destination and refuses one that already holds files", async (t) => {
  const parent = scratch(t);
  const url = "https://github.com/octo/hello-world.git";
  const preview = await previewClone({ url, parent, name: "hello-world" });
  assert.equal(preview.ok, true);
  assert.equal(preview.destination, join(parent, "hello-world"));
  assert.equal(preview.destinationState, "new");
  assert.equal(existsSync(preview.destination), false, "previewing creates nothing");

  mkdirSync(join(parent, "taken"));
  writeFileSync(join(parent, "taken", "mine.txt"), "mine\n");
  assert.deepEqual(await previewClone({ url, parent, name: "taken" }), { ok: false, problem: "destination_not_empty" });
  writeFileSync(join(parent, "a-file"), "x");
  assert.deepEqual(await previewClone({ url, parent, name: "a-file" }), { ok: false, problem: "destination_is_file" });
  mkdirSync(join(parent, "empty"));
  assert.equal((await previewClone({ url, parent, name: "empty" })).destinationState, "empty");
  assert.deepEqual(await previewClone({ url: "file:///etc", parent, name: "x" }), { ok: false, problem: "local" });
  assert.deepEqual(await previewClone({ url, parent, name: "../escape" }), { ok: false, problem: "name_invalid" });
  assert.equal((await previewClone({ url, parent: join(parent, "missing"), name: "x" })).problem, "parent_missing");

  // Running it against a folder that holds files refuses before Git runs and leaves the files alone.
  const refused = await cloneRepository({ url, parent, name: "taken" });
  assert.deepEqual(refused, { status: "invalid", problem: "destination_not_empty" });
  assert.deepEqual(listing(join(parent, "taken")), ["mine.txt"]);
  // Local sources are only reachable through the service's test option, never through the strict check.
  const source = join(parent, "source.git");
  git(parent, "init", "-q", "--bare", source);
  assert.deepEqual(await cloneRepository({ url: source, parent, name: "copy" }), { status: "invalid", problem: "local" });
  assert.equal(existsSync(join(parent, "copy")), false);
});

test("cloning an empty repository opens cleanly and guides the first save", async (t) => {
  const parent = scratch(t);
  const source = join(parent, "remote.git");
  git(parent, "init", "-q", "--bare", "-b", "main", source);
  const outcome = await cloneRepository({ url: source, parent, name: "fresh" }, { allowLocalSource: true });
  assert.equal(outcome.status, "cloned", JSON.stringify(outcome));
  assert.equal(outcome.path, join(parent, "fresh"));
  assert.equal(outcome.empty, true);
  assert.deepEqual(listing(parent).filter((name) => name.includes("gitcat-clone")), [], "the staging folder was moved into place");

  const snapshot = await getSnapshot(outcome.path);
  assert.equal(snapshot.head, "");
  assert.deepEqual(snapshot.commits, []);
  assert.deepEqual(snapshot.branches, []);
  assert.deepEqual(snapshot.remotes, ["origin"]);
  assert.equal(snapshot.isDirty, false);

  writeFileSync(join(outcome.path, "hello.txt"), "hi\n");
  identity(outcome.path);
  const dirty = await getSnapshot(outcome.path);
  const plan = await prepareBranchDelivery(outcome.path, { stateId: dirty.stateId, message: "First save", mergeToDefault: false }, "en");
  const saved = await executePlan(outcome.path, plan, "en");
  assert.equal(saved.error, undefined);
  assert.equal(git(outcome.path, "show", "HEAD:hello.txt"), "hi");
});

test("a repository with history clones into place with its files", async (t) => {
  const parent = scratch(t);
  const work = join(parent, "work");
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main"); identity(work);
  writeFileSync(join(work, "app.txt"), "app\n");
  git(work, "add", "."); git(work, "commit", "-qm", "base");
  mkdirSync(join(parent, "target"));
  const outcome = await cloneRepository({ url: work, parent, name: "target" }, { allowLocalSource: true });
  assert.equal(outcome.status, "cloned");
  assert.equal(outcome.empty, false);
  assert.equal(readFileSync(join(parent, "target", "app.txt"), "utf8"), "app\n");
  assert.equal((await getSnapshot(outcome.path)).commits.length, 1);
});

/** A server that accepts the connection and never answers, so a clone waits the way a stalled network does. */
async function silentServer(t) {
  const sockets = new Set();
  const server = createServer((socket) => { sockets.add(socket); socket.on("error", () => {}); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  return { url: `https://127.0.0.1:${server.address().port}/octo/slow.git`, connected: () => sockets.size > 0 };
}

test("a cancelled clone stops Git and removes only the folder it created", async (t) => {
  const parent = scratch(t);
  writeFileSync(join(parent, "keep.txt"), "mine\n");
  const { url, connected } = await silentServer(t);
  const controller = new AbortController();
  const running = cloneRepository({ url, parent, name: "slow" }, { signal: controller.signal });
  for (let attempt = 0; attempt < 200 && !connected(); attempt++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(connected(), "Git is waiting on the remote");
  assert.equal(listing(parent).some((name) => name.startsWith(".slow.gitcat-clone-")), true, "the partial copy lives in a folder of its own");
  controller.abort();
  const outcome = await running;
  assert.deepEqual(outcome, { status: "cancelled", cleaned: true });
  assert.deepEqual(listing(parent), ["keep.txt"], "the partial copy is gone and nothing else was touched");
});

test("a stalled or unreachable clone reports why and leaves nothing behind", async (t) => {
  const parent = scratch(t);
  const { url } = await silentServer(t);
  const stalled = await cloneRepository({ url, parent, name: "stalled" }, { idleTimeoutMs: 300 });
  assert.equal(stalled.status, "failed");
  assert.equal(stalled.reason, "timeout");
  assert.equal(stalled.cleaned, true);

  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  const refused = await cloneRepository({ url: `https://127.0.0.1:${port}/octo/x.git`, parent, name: "refused" });
  assert.equal(refused.status, "failed");
  assert.equal(refused.reason, "network", refused.detail);
  assert.deepEqual(listing(parent), []);

  assert.equal(classifyCloneFailure("remote: Repository not found.\nfatal: repository 'https://github.com/o/x/' not found"), "not_found");
  assert.equal(classifyCloneFailure("fatal: could not read Username for 'https://github.com': terminal prompts disabled"), "auth");
  assert.equal(classifyCloneFailure("git@github.com: Permission denied (publickey)."), "auth");
  assert.equal(classifyCloneFailure("Host key verification failed."), "host_key");
  assert.equal(classifyCloneFailure("fatal: unable to access 'https://x/': Could not resolve host: x"), "network");
});

test("opening, starting and cloning go through trusted IPC with the strict address check", async () => {
  const { readFile } = await import("node:fs/promises");
  const main = await readFile(join(root, "electron/main.ts"), "utf8");
  const preload = await readFile(join(root, "electron/preload.cjs"), "utf8");
  for (const channel of ["project:select", "project:open-parent", "project:start-tracking", "clone:choose-parent", "clone:preview", "clone:start", "clone:cancel"]) {
    const at = main.indexOf(`ipcMain.handle("${channel}"`);
    assert.ok(at >= 0, `${channel} is handled`);
    assert.match(main.slice(at, at + 400), /assertTrustedSender\(event\)/, `${channel} checks its sender`);
    assert.ok(preload.includes(`ipcRenderer.invoke("${channel}"`), `${channel} is bridged`);
  }
  // The renderer never names a folder to write in: only ids the main process issued for dialog answers.
  assert.match(main, /cloneParents\.get\(parentId\)/);
  assert.match(main, /takeSetup\(setupId, "track"\)/);
  assert.doesNotMatch(main, /allowLocalSource/, "people only ever get the strict address check");
});
