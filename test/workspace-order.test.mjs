import test from "node:test";
import assert from "node:assert/strict";
import { reorderWorkspacePaths } from "../dist-electron/shared/workspace-order.js";

test("tabs can move left or right, to either end or between projects", () => {
  const paths = ["/one", "/two", "/missing", "/four"];
  assert.deepEqual(reorderWorkspacePaths(paths, "/four", "/one", "before"), ["/four", "/one", "/two", "/missing"]);
  assert.deepEqual(reorderWorkspacePaths(paths, "/one", "/four", "after"), ["/two", "/missing", "/four", "/one"]);
  assert.deepEqual(reorderWorkspacePaths(paths, "/one", "/missing", "before"), ["/two", "/one", "/missing", "/four"]);
  assert.deepEqual(reorderWorkspacePaths(paths, "/four", "/two", "after"), ["/one", "/two", "/four", "/missing"]);
  assert.deepEqual(paths, ["/one", "/two", "/missing", "/four"]);
});

test("stale, self and unchanged drops preserve the current workspace", () => {
  const paths = ["/one", "/two", "/three"];
  assert.equal(reorderWorkspacePaths(paths, "/closed", "/two", "before"), paths);
  assert.equal(reorderWorkspacePaths(paths, "/one", "/closed", "after"), paths);
  assert.equal(reorderWorkspacePaths(paths, "/two", "/two", "after"), paths);
  assert.equal(reorderWorkspacePaths(paths, "/one", "/two", "before"), paths);
  assert.equal(reorderWorkspacePaths(paths, "/two", "/one", "after"), paths);
  assert.deepEqual(reorderWorkspacePaths([], "/one", "/two", "after"), []);
});
