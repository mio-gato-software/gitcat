import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { executableNames, findExecutable, pathEntries, wellKnownToolDirectories } =
  await import(pathToFileURL(join(root, "dist-electron/electron/executables.js")));

const present = (...paths) => {
  const set = new Set(paths);
  return (path) => set.has(path);
};

test("las herramientas se buscan más allá del PATH que hereda una app de escritorio", () => {
  // El PATH que launchd entrega a una app abierta desde Finder.
  const launchd = pathEntries("/usr/bin:/bin:/usr/sbin:/sbin", "darwin");
  const directories = [...launchd, ...wellKnownToolDirectories("darwin", "/Users/persona")];
  // gh vive en Homebrew: invisible con el PATH heredado, encontrado al ampliar la búsqueda.
  assert.equal(findExecutable("gh", launchd, present("/opt/homebrew/bin/gh"), "darwin"), undefined);
  assert.equal(findExecutable("gh", directories, present("/opt/homebrew/bin/gh"), "darwin"), "/opt/homebrew/bin/gh");
  // git sigue resolviéndose por el PATH heredado, que conserva la precedencia.
  assert.equal(findExecutable("git", directories, present("/usr/bin/git", "/opt/homebrew/bin/git"), "darwin"), "/usr/bin/git");
});

test("gana el primer directorio de la lista y los repetidos se ignoran", () => {
  const seen = [];
  const isExecutable = (path) => { seen.push(path); return path === "/b/tool"; };
  assert.equal(findExecutable("tool", ["/a", "/b", "/a", "/b"], isExecutable, "linux"), "/b/tool");
  assert.deepEqual(seen, ["/a/tool", "/b/tool"]);
});

test("un nombre con separador se comprueba tal cual, sin recorrer directorios", () => {
  assert.equal(findExecutable("/opt/gh", ["/usr/bin"], present("/opt/gh"), "darwin"), "/opt/gh");
  assert.equal(findExecutable("/opt/gh", ["/usr/bin"], present("/usr/bin/gh"), "darwin"), undefined);
});

test("en Windows se prueban las extensiones ejecutables", () => {
  assert.deepEqual(executableNames("gh", "linux"), ["gh"]);
  assert.deepEqual(executableNames("gh", "win32", ".EXE;.CMD"), ["gh", "gh.EXE", "gh.CMD"]);
  const tools = win32.join("C:\\", "tools");
  assert.equal(findExecutable("gh", [tools], present(win32.join(tools, "gh.EXE")), "win32"), win32.join(tools, "gh.EXE"));
  assert.equal(findExecutable("gh", ["/tools"], present("/tools/gh"), "linux"), "/tools/gh");
});

test("los directorios conocidos dependen de la plataforma", () => {
  const mac = wellKnownToolDirectories("darwin", "/Users/persona");
  assert.ok(mac.includes("/opt/homebrew/bin"));
  assert.ok(mac.includes("/Users/persona/.local/bin"));
  assert.ok(wellKnownToolDirectories("linux", "/home/persona").includes("/home/linuxbrew/.linuxbrew/bin"));
  assert.deepEqual(wellKnownToolDirectories("win32", "C:\\Users\\persona"), []);
});

test("pathEntries limpia entradas vacías y espacios", () => {
  assert.deepEqual(pathEntries(undefined), []);
  assert.deepEqual(pathEntries(`/usr/bin${process.platform === "win32" ? ";" : ":"} /opt/bin `), ["/usr/bin", "/opt/bin"]);
});
