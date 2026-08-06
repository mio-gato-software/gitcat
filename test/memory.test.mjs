import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { emptyMemory, forgetSshHost, identityKey, recallIdentity, recallRepository, rememberIdentity, rememberRepository, sanitizeMemory } =
  await import(pathToFileURL(join(root, "dist-electron/electron/memory.js")));

const now = "2026-08-06T16:00:00.000Z";

test("la identidad se recuerda por host y propietario, no por repositorio", () => {
  const memory = rememberIdentity(emptyMemory(), "GitHub.com", "Eliaquin", { account: "eliaquin", sshHost: "github-personal" }, now);
  assert.equal(identityKey("github.com", "eliaquin"), "github.com/eliaquin");
  assert.deepEqual(recallIdentity(memory, "github.com", "ELIAQUIN"), { account: "eliaquin", sshHost: "github-personal", confirmedAt: now });
  // Sirve para cualquier repositorio de ese propietario, no solo para el que lo enseñó.
  assert.equal(recallIdentity(memory, "github.com", "otra-persona"), undefined);
  assert.equal(recallIdentity(memory, "gitlab.com", "eliaquin"), undefined);
});

test("un dato nuevo no borra el anterior de la misma identidad", () => {
  const first = rememberIdentity(emptyMemory(), "github.com", "eliaquin", { sshHost: "github-personal" }, now);
  const second = rememberIdentity(first, "github.com", "eliaquin", { account: "eliaquin" }, "2026-08-07T10:00:00.000Z");
  assert.deepEqual(recallIdentity(second, "github.com", "eliaquin"), {
    account: "eliaquin", sshHost: "github-personal", confirmedAt: "2026-08-07T10:00:00.000Z"
  });
  assert.deepEqual(recallIdentity(first, "github.com", "eliaquin").account, undefined, "no muta la memoria anterior");
});

test("un alias que deja de responder como su propietario se olvida sin perder la cuenta", () => {
  const memory = rememberIdentity(emptyMemory(), "github.com", "eliaquin", { account: "eliaquin", sshHost: "obsoleto" }, now);
  const olvidado = forgetSshHost(memory, "github.com", "eliaquin");
  assert.deepEqual(recallIdentity(olvidado, "github.com", "eliaquin"), { account: "eliaquin", confirmedAt: now });
  const soloAlias = forgetSshHost(rememberIdentity(emptyMemory(), "github.com", "x", { sshHost: "a" }, now), "github.com", "x");
  assert.equal(recallIdentity(soloAlias, "github.com", "x"), undefined);
});

test("el repositorio recuerda cómo se publicó y se fusiona con lo anterior", () => {
  const first = rememberRepository(emptyMemory(), "/repo", { host: "github.com", owner: "eliaquin", protocol: "ssh", remote: "origin" }, now);
  assert.deepEqual(recallRepository(first, "/repo"), {
    host: "github.com", owner: "eliaquin", protocol: "ssh", remote: "origin", confirmedAt: now
  });
  const second = rememberRepository(first, "/repo", { remote: "upstream" }, "2026-08-07T10:00:00.000Z");
  assert.equal(recallRepository(second, "/repo").owner, "eliaquin");
  assert.equal(recallRepository(second, "/repo").remote, "upstream");
});

test("un archivo de memoria corrupto o manipulado no entra en el proceso", () => {
  assert.deepEqual(sanitizeMemory(null), emptyMemory());
  assert.deepEqual(sanitizeMemory("texto"), emptyMemory());
  const limpiado = sanitizeMemory({
    identities: {
      "github.com/eliaquin": { account: "eliaquin", sshHost: "github-personal", confirmedAt: now },
      "github.com/vacia": { account: "", sshHost: "  " },
      "github.com/rara": { account: 42 },
      "github.com/nula": null
    },
    repositories: {
      "/repo": { owner: "eliaquin", protocol: "ftp", remote: "origin", confirmedAt: "no es fecha" },
      "/vacio": {}
    },
    extra: "ignorado"
  });
  assert.deepEqual(Object.keys(limpiado.identities), ["github.com/eliaquin"]);
  assert.deepEqual(Object.keys(limpiado.repositories), ["/repo"]);
  assert.equal(limpiado.repositories["/repo"].protocol, undefined, "un protocolo inválido se descarta");
  assert.equal(limpiado.repositories["/repo"].confirmedAt, new Date(0).toISOString());
  assert.equal(limpiado.extra, undefined);
});

test("la memoria no crece sin límite", () => {
  let memory = emptyMemory();
  for (let index = 0; index < 260; index += 1) {
    memory = rememberRepository(memory, `/repo-${index}`, { owner: "eliaquin" }, new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString());
  }
  assert.equal(Object.keys(memory.repositories).length, 200);
  assert.equal(recallRepository(memory, "/repo-259").owner, "eliaquin", "se conserva lo más reciente");
  assert.equal(recallRepository(memory, "/repo-0"), undefined, "se descarta lo más antiguo");
});
