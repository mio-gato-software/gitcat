import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { parseRemoteUrls } = await import(pathToFileURL(join(root, "dist-electron/electron/remotes.js")));

test("cada remoto queda con su URL, y fetch manda cuando difieren", () => {
  const raw = [
    "origin\tgit@github.com:eliaquin/gitcat.git (fetch)",
    "origin\tgit@github.com:eliaquin/gitcat.git (push)",
    "upstream\thttps://github.com/otro/gitcat.git (fetch)",
    "upstream\thttps://github.com/otro/otro-destino.git (push)"
  ].join("\n");
  assert.deepEqual(parseRemoteUrls(raw), {
    origin: "git@github.com:eliaquin/gitcat.git",
    upstream: "https://github.com/otro/gitcat.git"
  });
});

test("una salida vacía o rara no inventa remotos", () => {
  assert.deepEqual(parseRemoteUrls(""), {});
  assert.deepEqual(parseRemoteUrls("origin"), {});
  assert.deepEqual(parseRemoteUrls("\n\n"), {});
});

test("coincide con lo que git escribe de verdad", () => {
  const repo = mkdtempSync(join(tmpdir(), "gitcat-remotes-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main", ".");
  git("remote", "add", "origin", "git@github-trabajo:empresa/proyecto.git");
  git("remote", "add", "personal", "https://github.com/yo/proyecto.git");
  const parsed = parseRemoteUrls(git("remote", "-v"));
  assert.equal(parsed.origin, "git@github-trabajo:empresa/proyecto.git");
  assert.equal(parsed.personal, "https://github.com/yo/proyecto.git");
});
