import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { findAccount, isSshAuthenticated, parseGhAccounts, parseSshGreeting, parseSshResolvedHostName, sshConfigHostAliases } =
  await import(pathToFileURL(join(root, "dist-electron/electron/host-identity.js")));

test("el saludo de SSH revela qué identidad respondió", () => {
  assert.equal(parseSshGreeting("Hi eliaquin! You've successfully authenticated, but GitHub does not provide shell access."), "eliaquin");
  assert.equal(parseSshGreeting("Hi eliaquin-exit83! You've successfully authenticated"), "eliaquin-exit83");
  assert.equal(parseSshGreeting("Permission denied (publickey)."), undefined);
});

test("autenticar y autenticar como la persona correcta son cosas distintas", () => {
  const output = "Hi eliaquin-exit83! You've successfully authenticated, but GitHub does not provide shell access.";
  assert.equal(isSshAuthenticated(output, 1), true);
  assert.notEqual(parseSshGreeting(output), "eliaquin");
  assert.equal(isSshAuthenticated("Permission denied (publickey).", 255), false);
});

test("solo se prueban alias de ssh_config que se puedan marcar", () => {
  const config = [
    "Host github.com",
    "  User git",
    "Host github-personal gh-personal",
    "  HostName github.com",
    "Host *.internal",
    "Host !excluido",
    "Host trabajo # comentario"
  ].join("\n");
  assert.deepEqual(sshConfigHostAliases(config), ["github.com", "github-personal", "gh-personal", "trabajo"]);
});

test("ssh -G resuelve el host efectivo del alias", () => {
  assert.equal(parseSshResolvedHostName("user git\nhostname GitHub.com\nport 22\n"), "github.com");
  assert.equal(parseSshResolvedHostName("port 22\n"), undefined);
});

test("se leen todas las cuentas de gh, no solo la activa", () => {
  const json = JSON.stringify({
    hosts: {
      "github.com": [
        { state: "success", active: true, login: "eliaquin-exit83" },
        { state: "success", active: false, login: "eliaquin" },
        { state: "error", active: false, login: "caducada" }
      ]
    }
  });
  const accounts = parseGhAccounts(json, "github.com");
  assert.deepEqual(accounts, [
    { login: "eliaquin-exit83", active: true },
    { login: "eliaquin", active: false }
  ]);
  assert.deepEqual(findAccount(accounts, "ELIAQUIN"), { login: "eliaquin", active: false });
  assert.equal(findAccount(accounts, "otra-persona"), undefined);
  assert.deepEqual(parseGhAccounts("no es json", "github.com"), []);
  assert.deepEqual(parseGhAccounts(json, "gitlab.com"), []);
});
