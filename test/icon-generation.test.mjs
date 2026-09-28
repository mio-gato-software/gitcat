import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const script = new URL("../scripts/generate-icons.mjs", import.meta.url);
const root = dirname(dirname(fileURLToPath(script)));

for (const hasRsvg of [true, false]) {
  test(`Mac icon generation keeps its ${hasRsvg ? "librsvg" : "Electron"} route without loading Windows dependencies`, () => {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import childProcess from "node:child_process";
      import { registerHooks, syncBuiltinESMExports } from "node:module";
      const calls = [];
      childProcess.execFileSync = (command, args) => {
        calls.push({ command, args });
        if (command === "sh" && !${hasRsvg}) throw new Error("librsvg is absent");
        return Buffer.alloc(0);
      };
      syncBuiltinESMExports();
      Object.defineProperty(process, "platform", { value: "darwin" });
      registerHooks({ resolve(specifier, context, next) {
        if (specifier === "@resvg/resvg-js" || specifier === "electron") {
          throw new Error("Mac icon generation must not load a new package: " + specifier);
        }
        return next(specifier, context);
      } });
      const finished = new Error("finished");
      process.exit = code => { if (code !== 0) throw new Error("Unexpected exit " + code); throw finished; };
      try { await import(${JSON.stringify(script.href)}); } catch (error) { if (error !== finished) throw error; }
      console.log(JSON.stringify(calls));
    `], { cwd: root, encoding: "utf8" });
    const calls = JSON.parse(output.trim().split(/\r?\n/).at(-1));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], { command: "sh", args: ["-lc", "command -v rsvg-convert"] });
    assert.deepEqual(calls[1], hasRsvg
      ? { command: "rsvg-convert", args: ["-w", "1024", "-h", "1024", "-o", join(root, "build/icon.png"), join(root, "build/icon.svg")] }
      : { command: join(root, "node_modules", ".bin", "electron"), args: [join(root, "scripts/render-icon.cjs"), join(root, "build/icon.svg"), join(root, "build/icon.png")] });
  });
}
