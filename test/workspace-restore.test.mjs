import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const electronStub = pathToFileURL(join(root, "test/helpers/electron-stub.mjs")).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "electron" ? { url: electronStub, shortCircuit: true } : nextResolve(specifier, context);
  }
});
const { getSnapshot, rootCommits } = await import(pathToFileURL(join(root, "dist-electron/electron/git-service.js")));
const {
  classifyFailure, compareFingerprints, fingerprintFrom, inspectProject, nearestExistingFolder, normalizeRemoteUrl, parseWorkspace,
  relocateProject, restoreProjects, volumeRoot
} = await import(pathToFileURL(join(root, "dist-electron/electron/workspace-restore.js")));
const { emptyMemory, recallRepository, relocateRepository, rememberRepository } =
  await import(pathToFileURL(join(root, "dist-electron/electron/memory.js")));

// Real folders throughout; the realpath keeps macOS's /var → /private/var link out of the comparisons.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "gitcat-workspace-")));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

function makeRepo(path, remote) {
  mkdirSync(path, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: path, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(path, "readme.txt"), `${path}\n`);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  if (remote) git("remote", "add", "origin", remote);
  return path;
}

const record = (paths, activePath, fingerprints = {}) => ({ paths, activePath, fingerprints });
const reasons = (restored) => Object.fromEntries(restored.unavailable.map((project) => [project.path, project.reason]));

test("un disco desconectado deja el proyecto guardado y vuelve al reconectarlo", async () => {
  // A pretend /Volumes: each folder inside it is one drive that can be unplugged.
  const volumes = join(scratch, "Volumes");
  const drive = join(volumes, "Backup");
  const repo = makeRepo(join(drive, "code", "app"));
  const other = makeRepo(join(scratch, "local-app"));
  const options = { volumeRootOf: (path) => path.startsWith(volumes + sep) ? join(volumes, relative(volumes, path).split(sep)[0]) : undefined };
  const saved = record([other, repo], repo);

  renameSync(drive, join(scratch, "unplugged"));
  const offline = await restoreProjects(saved, getSnapshot, options);
  assert.deepEqual(offline.projects.map((project) => project.path), [other]);
  assert.deepEqual(reasons(offline), { [repo]: "storage" });
  assert.equal(offline.unavailable[0].name, "app");
  // Nothing is forgotten: the saved list, its order and the project in front all survive.
  assert.deepEqual(offline.record.paths, [other, repo]);
  assert.equal(offline.activePath, repo);
  assert.equal(offline.record.activePath, repo);

  renameSync(join(scratch, "unplugged"), drive);
  const online = await restoreProjects(offline.record, getSnapshot, options);
  assert.deepEqual(online.projects.map((project) => project.path), [other, repo]);
  assert.deepEqual(online.unavailable, []);
  assert.equal(online.activePath, repo);
});

test("una carpeta movida queda como no encontrada y se localiza validando que es el mismo repositorio", async () => {
  const base = join(scratch, "moved");
  const repo = makeRepo(join(base, "app"), "git@github.com:persona/app.git");
  const snapshot = await getSnapshot(repo);
  const fingerprint = fingerprintFrom(await rootCommits(repo), snapshot.remoteUrls);
  const saved = record([repo, join(base, "other")], repo, { [repo]: fingerprint });

  const newHome = join(base, "projects", "app");
  mkdirSync(dirname(newHome), { recursive: true });
  renameSync(repo, newHome);
  const restored = await restoreProjects(saved, getSnapshot);
  assert.deepEqual(reasons(restored), { [repo]: "missing", [join(base, "other")]: "missing" });
  assert.deepEqual(restored.record.paths, saved.paths);
  assert.deepEqual(restored.record.fingerprints, { [repo]: fingerprint }, "The fingerprint waits for the project to be found");
  assert.equal(nearestExistingFolder(repo), base, "The folder dialog opens where the project used to be");

  // The new place is read as a repository first, then compared with what was saved about the old one.
  const found = await inspectProject(join(newHome), getSnapshot, { exactRoot: false });
  assert.ok("project" in found);
  const candidate = fingerprintFrom(await rootCommits(found.project.path), found.project.remoteUrls);
  assert.equal(compareFingerprints(saved.fingerprints[repo], candidate), "same");
  const relocated = relocateProject(restored.record, repo, found.project.path, candidate);
  assert.deepEqual(relocated.paths, [newHome, join(base, "other")], "It takes the old entry's place");
  assert.equal(relocated.activePath, newHome);
  assert.deepEqual(Object.keys(relocated.fingerprints), [newHome]);

  // Another repository offered in its place is not trusted silently.
  const stranger = makeRepo(join(base, "stranger"), "https://github.com/someone/else.git");
  const strangerPrint = fingerprintFrom(await rootCommits(stranger), (await getSnapshot(stranger)).remoteUrls);
  assert.equal(compareFingerprints(saved.fingerprints[repo], strangerPrint), "different");
  assert.equal(compareFingerprints(undefined, strangerPrint), "unverified");
});

test("un permiso retirado se distingue de una carpeta que dejó de ser repositorio", { skip: process.getuid?.() === 0 && "root reads everything" }, async () => {
  const locked = makeRepo(join(scratch, "locked"));
  const plain = join(scratch, "plain-folder");
  mkdirSync(plain);
  writeFileSync(join(plain, "notes.txt"), "not a repository\n");
  const saved = record([locked, plain], locked);

  chmodSync(locked, 0o000);
  try {
    const restored = await restoreProjects(saved, getSnapshot);
    assert.deepEqual(reasons(restored), { [locked]: "permission", [plain]: "not_repository" });
    assert.deepEqual(restored.record.paths, [locked, plain]);
    assert.equal(restored.activePath, locked);
  } finally { chmodSync(locked, 0o755); }

  const recovered = await restoreProjects(saved, getSnapshot);
  assert.deepEqual(recovered.projects.map((project) => project.path), [locked]);
  assert.deepEqual(reasons(recovered), { [plain]: "not_repository" });
});

test("un fallo de la herramienta no se confunde con una carpeta que falta", async () => {
  const repo = makeRepo(join(scratch, "tool-failure"));
  const missingGit = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT", syscall: "spawn git", path: "git" });
  let failing = true;
  const flakyLoad = async (path) => {
    if (failing) throw missingGit;
    return getSnapshot(path);
  };
  const saved = record([repo], repo);
  const first = await restoreProjects(saved, flakyLoad);
  assert.deepEqual(reasons(first), { [repo]: "tool" });
  assert.match(first.unavailable[0].detail, /spawn git ENOENT/);
  assert.deepEqual(first.record.paths, [repo]);

  // Git comes back: the same saved entry opens again without the person doing anything else.
  failing = false;
  const later = await restoreProjects(first.record, flakyLoad);
  assert.deepEqual(later.projects.map((project) => project.path), [repo]);

  assert.equal(classifyFailure(repo, new Error("git status excedió el tiempo máximo de espera.")), "tool");
  assert.equal(classifyFailure(repo, new Error("fatal: detected dubious ownership in repository")), "permission");
  assert.equal(classifyFailure(repo, new Error("fatal: not a git repository: /Volumes/Gone/.git/worktrees/app")), "storage");
  assert.equal(classifyFailure(repo, new Error("fatal: not a git repository (or any of the parent directories): .git")), "not_repository");
  assert.equal(classifyFailure(join(repo, "missing"), missingGit), "missing", "A missing folder is not a missing Git");
});

test("una carpeta sin su .git dentro de otro repositorio no se confunde con el proyecto", async () => {
  const outer = makeRepo(join(scratch, "outer"));
  const inner = makeRepo(join(outer, "inner"));
  rmSync(join(inner, ".git"), { recursive: true, force: true });
  const restored = await restoreProjects(record([inner], inner), getSnapshot);
  assert.deepEqual(reasons(restored), { [inner]: "not_repository" });
  assert.match(restored.unavailable[0].detail, new RegExp(outer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // Picked by hand, a folder inside a repository means that repository.
  const picked = await inspectProject(inner, getSnapshot, { exactRoot: false });
  assert.equal(picked.project.path, outer);
});

test("un proyecto guardado a través de un enlace se guarda con la ruta que usa Git", { skip: process.platform === "win32" }, async () => {
  const repo = makeRepo(join(scratch, "linked-target"));
  const link = join(scratch, "linked");
  symlinkSync(repo, link);
  const restored = await restoreProjects(record([link], link, { [link]: { roots: ["abc"], remotes: [] } }), getSnapshot);
  assert.deepEqual(restored.record.paths, [repo]);
  assert.equal(restored.activePath, repo);
  assert.deepEqual(restored.record.fingerprints, { [repo]: { roots: ["abc"], remotes: [] } });
});

test("el archivo del workspace se sanea sin perder referencias", () => {
  const parsed = parseWorkspace({
    paths: ["/a", "/b", "/a", 42, "/c/../d"],
    activePath: "/b",
    fingerprints: { "/a": { roots: ["r1", 3], remotes: ["github.com/x/y"] }, "/gone": { roots: ["r2"] }, "/b": "nope" }
  });
  assert.deepEqual(parsed.paths, ["/a", "/b", "/d"]);
  assert.equal(parsed.activePath, "/b");
  assert.deepEqual(parsed.fingerprints, { "/a": { roots: ["r1"], remotes: ["github.com/x/y"] } });
  assert.deepEqual(parseWorkspace(null), { paths: [], activePath: undefined, fingerprints: {} });
  assert.equal(parseWorkspace({ paths: ["/a"], activePath: "/z" }).activePath, undefined);
});

test("localizar una carpeta que ya está abierta retira la entrada vieja en lugar de duplicarla", () => {
  const relocated = relocateProject(record(["/old", "/open"], "/old", { "/old": { roots: ["r"], remotes: [] } }), "/old", "/open");
  assert.deepEqual(relocated.paths, ["/open"]);
  assert.equal(relocated.activePath, "/open");
  assert.deepEqual(relocated.fingerprints, {});
  const untouched = record(["/a"], "/a");
  assert.equal(relocateProject(untouched, "/unknown", "/b"), untouched);
});

test("las direcciones de un remoto se comparan en una sola forma", () => {
  const forms = ["git@github.com:Persona/App.git", "https://github.com/persona/app.git", "ssh://git@github.com:22/persona/app", "https://user@github.com/persona/app/"];
  assert.deepEqual([...new Set(forms.map(normalizeRemoteUrl))], ["github.com/persona/app"]);
  assert.equal(normalizeRemoteUrl("/srv/git/app.git"), "/srv/git/app");
  assert.equal(compareFingerprints({ roots: [], remotes: [] }, { roots: ["a"], remotes: [] }), "unverified");
  assert.equal(compareFingerprints({ roots: ["a"], remotes: [] }, { roots: [], remotes: ["x"] }), "unverified");
  assert.equal(compareFingerprints({ roots: ["a"], remotes: ["x"] }, { roots: ["b"], remotes: ["x"] }), "same");
});

test("el punto de montaje de un disco extraíble depende de la plataforma", () => {
  assert.equal(volumeRoot("/Volumes/Backup/code/app", "darwin"), "/Volumes/Backup");
  assert.equal(volumeRoot("/Users/persona/code/app", "darwin"), undefined);
  assert.equal(volumeRoot("/media/persona/usb/app", "linux"), "/media/persona/usb");
  assert.equal(volumeRoot("/run/media/persona/usb/app", "linux"), "/run/media/persona/usb");
  assert.equal(volumeRoot("/mnt/share/app", "linux"), "/mnt/share");
  assert.equal(volumeRoot("/home/persona/app", "linux"), undefined);
  assert.equal(volumeRoot("E:\\code\\app", "win32"), "E:\\");
});

test("lo recordado de un repositorio lo sigue solo a su nueva ubicación", () => {
  const now = "2026-09-26T10:00:00.000Z";
  const memory = rememberRepository(emptyMemory(), "/old/app", { remote: "origin", protocol: "ssh" }, now);
  const moved = relocateRepository(memory, "/old/app", "/new/app");
  assert.equal(recallRepository(moved, "/old/app"), undefined);
  assert.deepEqual(recallRepository(moved, "/new/app"), { remote: "origin", protocol: "ssh", confirmedAt: now });
  assert.equal(relocateRepository(memory, "/unknown", "/new/app"), memory);
});
