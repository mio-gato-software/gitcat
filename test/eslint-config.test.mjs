import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const root = fileURLToPath(new URL("../", import.meta.url));

test("lint checks this checkout without entering nested Kilo worktrees", async () => {
  const eslint = new ESLint({ cwd: root });
  assert.equal(await eslint.isPathIgnored(".kilo/worktrees/example/src/App.tsx"), true);
  assert.equal(await eslint.isPathIgnored("src/App.tsx"), false);
  const [result] = await eslint.lintText("const value: string = 'ok'; void value;", { filePath: "src/lint-check.ts" });
  assert.deepEqual(result.messages, []);
});
