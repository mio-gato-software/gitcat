import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { load } from "js-yaml";

const workflow = (name) => load(readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8"));

test("PR events cannot consume the existing release workflow's version counter", () => {
  const release = workflow("desktop-ci");
  const pr = workflow("desktop-pr");
  assert.equal(release.name, "Desktop CI", "retain the existing release workflow identity");
  assert.deepEqual(Object.keys(release.on).sort(), ["push", "workflow_dispatch"]);
  assert.deepEqual(release.on.push.branches, ["main"]);
  assert.deepEqual(Object.keys(pr.on), ["pull_request"]);
  assert.notEqual(pr.name, release.name);
  assert.notEqual(pr.concurrency.group, release.concurrency.group);
});

test("PR and release runs share the same complete desktop build without sharing a counter", () => {
  const release = workflow("desktop-ci");
  const pr = workflow("desktop-pr");
  const build = workflow("desktop-build");
  assert.equal(release.jobs.desktop.uses, "./.github/workflows/desktop-build.yml");
  assert.equal(pr.jobs.desktop.uses, release.jobs.desktop.uses);
  assert.deepEqual(Object.keys(build.on), ["workflow_call"]);
  assert.equal(build.concurrency, undefined, "the shared build must not cancel its caller");
  assert.deepEqual(build.jobs.desktop.strategy.matrix.include.map(({ platform, arch }) => [platform, arch]), [
    ["win", "x64"], ["mac", "arm64"], ["mac", "x64"]
  ]);
  const steps = build.jobs.desktop.steps;
  const version = steps.find(({ name }) => name === "Calculate CI app version");
  assert.match(version.run, /node scripts\/ci-version\.mjs/);
  for (const scope of [release, release.jobs.desktop, pr, pr.jobs.desktop, build, build.jobs.desktop, version]) {
    assert.equal(scope.env?.GITHUB_RUN_NUMBER, undefined, "use the caller's native run number");
  }
  assert.ok(steps.some(({ run }) => run === "npm test"));
  assert.ok(steps.some(({ run }) => run === "node scripts/check-ui.cjs"));
  assert.ok(steps.some(({ run }) => run?.includes("electron-builder") && run.includes("--publish never")));
  assert.ok(steps.some(({ name }) => name === "Upload installers"));
});

test("only the main workflow can publish after all shared desktop jobs succeed", () => {
  const release = workflow("desktop-ci");
  assert.deepEqual(Object.keys(workflow("desktop-pr").jobs), ["desktop"]);
  assert.deepEqual(Object.keys(workflow("desktop-build").jobs), ["desktop"]);
  assert.equal(release.jobs.preview.needs, "desktop");
  assert.equal(release.jobs.preview.if, "github.ref == 'refs/heads/main' && github.event_name != 'pull_request'");
  assert.equal(release.jobs.preview.permissions.contents, "write");
  assert.equal(workflow("desktop-pr").permissions.contents, "read");
  assert.equal(workflow("desktop-build").permissions.contents, "read");
});
