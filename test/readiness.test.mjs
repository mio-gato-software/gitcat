import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Before a first save or a publish, GitCat reads what Git needs from this Mac: Git itself, who saves
// are attributed to, and whether the remote can be reached with the sign-in already here. Every Git
// setting these tests touch lives in a disposable HOME; this machine's own configuration is never read
// or written.
const sandbox = mkdtempSync(join(tmpdir(), "gitcat-readiness-"));
const home = join(sandbox, "home");
mkdirSync(home);
const globalConfig = join(home, ".gitconfig");
writeFileSync(globalConfig, "");
process.env.HOME = home;
process.env.GIT_CONFIG_GLOBAL = globalConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.XDG_CONFIG_HOME = join(home, ".config");
process.env.GH_CONFIG_DIR = join(home, ".config", "gh");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const electronStub = pathToFileURL(join(root, "test/helpers/electron-stub.mjs")).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "electron" ? { url: electronStub, shortCircuit: true } : nextResolve(specifier, context);
  }
});
const service = await import(pathToFileURL(join(root, "dist-electron/electron/git-service.js")));
const readiness = await import(pathToFileURL(join(root, "dist-electron/electron/readiness.js")));

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function repository(prefix, { identity } = {}) {
  const path = mkdtempSync(join(sandbox, prefix));
  git(path, "init", "-q", "-b", "main");
  if (identity) { git(path, "config", "user.name", identity.name); git(path, "config", "user.email", identity.email); }
  return path;
}
const setGlobal = (name, email) => { writeFileSync(globalConfig, ""); if (name) git(sandbox, "config", "--global", "user.name", name); if (email) git(sandbox, "config", "--global", "user.email", email); };

test("sin nombre ni correo en ningún sitio, el autor falta y se dice antes del primer guardado", async (t) => {
  t.after(() => setGlobal());
  setGlobal();
  const path = repository("gitcat-ready-missing-");
  const report = await service.checkReadiness(path);
  assert.equal(report.git.status, "ok");
  assert.match(report.git.version, /^\d+\.\d+/);
  assert.equal(report.author.status, "missing");
  assert.equal(report.author.name, undefined);
  assert.deepEqual(report.author.repository, {});
  assert.deepEqual(report.author.global, {});
  assert.equal(report.remote.status, "none", "Saving never needs a remote");
});

test("cuando el repositorio y la configuración global difieren, se informa la identidad efectiva, su origen y ambas", async (t) => {
  t.after(() => setGlobal());
  setGlobal("Ana Global", "ana@personal.example");
  const own = repository("gitcat-ready-own-", { identity: { name: "Ana Trabajo", email: "ana@empresa.example" } });
  const report = await service.checkReadiness(own);
  assert.equal(report.author.status, "ok");
  assert.deepEqual(report.author.name, { value: "Ana Trabajo", scope: "local" });
  assert.deepEqual(report.author.email, { value: "ana@empresa.example", scope: "local" });
  assert.deepEqual(report.author.repository, { name: "Ana Trabajo", email: "ana@empresa.example" });
  assert.deepEqual(report.author.global, { name: "Ana Global", email: "ana@personal.example" });
  assert.equal(report.author.overridesGlobal, true);

  // Without its own values, the repository falls back to the global ones, and says so.
  const plain = repository("gitcat-ready-plain-");
  const fallback = await service.checkReadiness(plain);
  assert.deepEqual(fallback.author.name, { value: "Ana Global", scope: "global" });
  assert.equal(fallback.author.overridesGlobal, false);

  // Without a repository, only this Mac's settings count.
  const outside = await service.checkReadiness(undefined);
  assert.equal(outside.repoPath, undefined);
  assert.deepEqual(outside.author.email, { value: "ana@personal.example", scope: "global" });
});

test("el autor efectivo sigue el orden de Git y un valor vacío cuenta como ausente", () => {
  const entries = readiness.parseIdentityConfig([
    "system\tuser.name Sistema",
    "global\tfile:/h/.gitconfig\tuser.name Global Uno",
    "global\tuser.email uno@example.com",
    "local\tuser.email ",
    "not-a-scope\tuser.name Nadie"
  ].join("\n"));
  const author = readiness.authorReadiness(entries);
  assert.deepEqual(author.name, { value: "Global Uno", scope: "global" });
  assert.equal(author.email, undefined, "An empty repository value hides the global one, as Git does");
  assert.equal(author.status, "partial");
  const outside = readiness.authorReadiness(entries, { repository: false });
  assert.deepEqual(outside.email, { value: "uno@example.com", scope: "global" });
  assert.equal(readiness.authorReadiness([]).status, "missing");
});

test("un remoto que no responde se clasifica como sin conexión, por HTTPS y por SSH, sin preguntar nada", async () => {
  const path = repository("gitcat-ready-offline-", { identity: { name: "Prueba", email: "prueba@example.com" } });
  git(path, "remote", "add", "origin", "https://token-secreto@127.0.0.1:1/octo/x.git");
  git(path, "remote", "add", "ssh-remote", "ssh://git@127.0.0.1:1/octo/x.git");
  const before = readFileSync(join(path, ".git", "config"), "utf8");

  const unchecked = await service.checkReadiness(path);
  assert.equal(unchecked.remote.status, "found");
  assert.equal(unchecked.remote.access, "not_checked", "Without asking, nothing contacts the remote");
  assert.equal(unchecked.remote.name, "origin");
  assert.equal(unchecked.remote.source, "origin");
  assert.equal(unchecked.remote.url, "https://127.0.0.1:1/octo/x.git", "A token written into the address is never shown");
  assert.equal(unchecked.remote.protocol, "https");
  assert.equal(unchecked.remote.host, "127.0.0.1");
  assert.equal(unchecked.remote.helper, "none");
  assert.deepEqual(unchecked.remote.remotes, ["origin", "ssh-remote"]);

  const https = await service.checkReadiness(path, { access: true });
  assert.equal(https.remote.access, "offline");
  assert.doesNotMatch(https.remote.detail ?? "", /token-secreto/);
  assert.equal(https.remote.account, undefined, "Accounts are only looked up for GitHub");

  const ssh = await service.checkReadiness(path, { remote: "ssh-remote", access: true });
  assert.equal(ssh.remote.source, "requested");
  assert.equal(ssh.remote.protocol, "ssh");
  assert.equal(ssh.remote.access, "offline");
  assert.equal(readFileSync(join(path, ".git", "config"), "utf8"), before, "Checking changes no configuration");
});

test("la rama publicada decide el remoto, y un repositorio que no existe se distingue de uno accesible", async () => {
  const path = repository("gitcat-ready-upstream-", { identity: { name: "Prueba", email: "prueba@example.com" } });
  writeFileSync(join(path, "a.txt"), "a\n");
  git(path, "add", "-A"); git(path, "commit", "-qm", "uno");
  const bare = join(sandbox, "publicado.git");
  git(sandbox, "init", "-q", "--bare", bare);
  git(path, "remote", "add", "origin", join(sandbox, "no-existe.git"));
  git(path, "remote", "add", "publicado", bare);
  git(path, "push", "-q", "-u", "publicado", "main");
  const report = await service.checkReadiness(path, { access: true });
  assert.equal(report.remote.name, "publicado");
  assert.equal(report.remote.source, "upstream");
  assert.equal(report.remote.upstream, "publicado/main");
  assert.equal(report.remote.protocol, "local");
  assert.equal(report.remote.access, "ok");
  const missing = await service.checkReadiness(path, { remote: "origin", access: true });
  assert.equal(missing.remote.access, "not_found");
});

test("el acceso se clasifica por lo que Git dice: credenciales, rechazo, inexistente, huella y red", () => {
  const kind = (output, code = 128) => readiness.classifyAccess({ code, output });
  assert.equal(kind("", 0), "ok");
  assert.equal(kind("fatal: could not read Username for 'https://github.com': terminal prompts disabled"), "credentials");
  assert.equal(kind("remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for 'https://github.com/o/r.git/'"), "credentials");
  assert.equal(kind("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository."), "denied");
  assert.equal(kind("remote: Permission to octo/r.git denied to gato.\nfatal: unable to access 'https://github.com/octo/r.git/': The requested URL returned error: 403"), "denied");
  assert.equal(kind("remote: Repository not found.\nfatal: repository 'https://github.com/octo/nada.git/' not found"), "not_found");
  assert.equal(kind("Host key verification failed.\nfatal: Could not read from remote repository."), "host_key");
  assert.equal(kind("ssh: Could not resolve hostname github.com: nodename nor servname provided, or not known"), "offline");
  assert.equal(kind("fatal: unable to access 'https://127.0.0.1:1/x.git/': Failed to connect to 127.0.0.1 port 1 after 0 ms: Couldn't connect to server"), "offline");
  assert.equal(readiness.classifyAccess({ timedOut: true }), "offline");
  assert.equal(kind("something nobody has seen"), "unknown");
  assert.equal(readiness.redactSecrets("https://gato:ghp_abcdefghijklmnop@github.com/o/r and ghp_abcdefghijklmnop"), "https://github.com/o/r and ghp_…");
});

test("con varias cuentas de GitHub se muestran todas, cuál está activa y cuál firma de verdad, sin cambiar ninguna", () => {
  const { accountReadiness, credentialHelperKind } = readiness;
  const accounts = [{ login: "eliaquin-exit83", active: true }, { login: "eliaquin", active: false }];
  // SSH: the key's own greeting is the proof, even when gh's active account is someone else.
  const ssh = accountReadiness({ ghInstalled: true, accounts, protocol: "ssh", sshLogin: "eliaquin", access: "ok" });
  assert.deepEqual(ssh, { gh: "signed_in", accounts, sshLogin: "eliaquin", verified: "eliaquin", verifiedBy: "ssh", differs: true });
  // HTTPS through gh: the active account is the one that answered.
  const https = accountReadiness({ ghInstalled: true, accounts, protocol: "https", helper: credentialHelperKind(["", "!/opt/homebrew/bin/gh auth git-credential"]), access: "ok" });
  assert.equal(https.verified, "eliaquin-exit83");
  assert.equal(https.verifiedBy, "gh");
  assert.equal(https.differs, false);
  // Another helper keeps the sign-in: GitCat cannot tell which account it holds, so it claims none.
  const keychain = accountReadiness({ ghInstalled: true, accounts, protocol: "https", helper: "osxkeychain", access: "ok" });
  assert.equal(keychain.verified, undefined);
  // Nothing verified when the check failed, and a missing or signed-out gh is told apart.
  assert.equal(accountReadiness({ ghInstalled: true, accounts, protocol: "https", helper: "gh", access: "credentials" }).verified, undefined);
  assert.equal(accountReadiness({ ghInstalled: false, accounts: [], protocol: "https", access: "ok" }).gh, "missing");
  assert.equal(accountReadiness({ ghInstalled: true, accounts: [], protocol: "https", access: "ok" }).gh, "signed_out");
  // An empty helper value forgets the ones before it, as Git does.
  assert.equal(credentialHelperKind(["osxkeychain", "", "store"]), "store");
  assert.equal(credentialHelperKind(["osxkeychain", ""]), "none");
  assert.equal(credentialHelperKind([]), "none");
});

test("las direcciones se leen sin tocarlas y el remoto se elige como lo haría un push", () => {
  const { parseRemoteAddress, displayUrl, selectRemote } = readiness;
  assert.deepEqual(parseRemoteAddress("git@github-personal:octo/gato.git"), { protocol: "ssh", host: "github-personal", path: "octo/gato" });
  assert.deepEqual(parseRemoteAddress("https://github.com/octo/gato.git"), { protocol: "https", host: "github.com", path: "octo/gato" });
  assert.deepEqual(parseRemoteAddress("ssh://git@127.0.0.1:1/x.git"), { protocol: "ssh", host: "127.0.0.1", port: "1", path: "x" });
  assert.equal(parseRemoteAddress("/srv/repos/x.git").protocol, "local");
  assert.equal(displayUrl("https://user:secret@example.com/r.git"), "https://example.com/r.git");
  assert.equal(displayUrl("git@github.com:o/r.git"), "git@github.com:o/r.git");
  const branches = [{ name: "main", isCurrent: true, upstream: "fork/main" }];
  assert.deepEqual(selectRemote(branches, ["origin", "fork"]), { name: "fork", source: "upstream", upstream: "fork/main" });
  assert.deepEqual(selectRemote([], ["origin", "fork"]), { name: "origin", source: "origin" });
  assert.deepEqual(selectRemote([], ["fork"]), { name: "fork", source: "only" });
  assert.deepEqual(selectRemote([], ["b", "c"]), { name: "b", source: "first" });
  assert.deepEqual(selectRemote([], ["b", "c"], "c"), { name: "c", source: "requested" });
  assert.equal(selectRemote([], []), undefined);
});

test("la identidad global se revisa antes de escribirse y solo cambia la configuración global aislada", async (t) => {
  t.after(() => setGlobal());
  setGlobal();
  const own = repository("gitcat-ready-scope-", { identity: { name: "Repo Propio", email: "repo@example.com" } });
  const plan = await service.prepareOperation(own, "set_identity", { user: " Ana Gato ", email: "ana@example.com", scope: "global" }, "en");
  assert.equal(plan.command, 'git config --global user.name "Ana Gato" && git config --global user.email "ana@example.com"');
  assert.equal(plan.requiresConfirmation, true);
  assert.match(plan.summary, /every repository on this Mac/);
  const effects = plan.effects.join("\n");
  assert.match(effects, /No global identity is set on this Mac yet/);
  assert.match(effects, /This repository has its own identity \(Repo Propio <repo@example\.com>\) and keeps using it/);
  assert.match(effects, /existing commits keep their author/);
  assert.equal(readFileSync(globalConfig, "utf8"), "", "Preparing writes nothing");
  await assert.rejects(() => service.prepareOperation(own, "set_identity", { user: "Ana", email: "ana@example.com", scope: "system" }, "en"), /this repository or for all of them/);

  const done = await service.executePlan(own, plan, "en");
  assert.equal(done.error, undefined, done.error);
  assert.match(readFileSync(globalConfig, "utf8"), /name = Ana Gato[\s\S]*email = ana@example\.com/);
  assert.equal(git(own, "config", "--local", "user.name"), "Repo Propio", "The repository's own identity is untouched");
  const after = await service.checkReadiness(own);
  assert.deepEqual(after.author.global, { name: "Ana Gato", email: "ana@example.com" });
  assert.equal(after.author.name.scope, "local");

  // Repository scope stays the default and names what the rest of this Mac keeps.
  const plain = repository("gitcat-ready-local-");
  const local = await service.prepareOperation(plain, "set_identity", { user: "Solo Aquí", email: "aqui@example.com" }, "en");
  assert.equal(local.command, 'git config user.name "Solo Aquí" && git config user.email "aqui@example.com"');
  assert.match(local.effects.join("\n"), /Other repositories on this Mac keep using Ana Gato <ana@example\.com>/);
  assert.equal((await service.executePlan(plain, local, "en")).error, undefined);
  assert.equal(git(plain, "config", "--local", "user.email"), "aqui@example.com");
  assert.match(readFileSync(globalConfig, "utf8"), /ana@example\.com/);
  assert.doesNotMatch(readFileSync(globalConfig, "utf8"), /aqui@example\.com/);
  assert.equal(existsSync(join(home, ".config", "git", "config")), false);
});
