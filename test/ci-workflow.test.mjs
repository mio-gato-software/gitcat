import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
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

test("Mac packaging stays covered without uploading unsigned Mac downloads", () => {
  const steps = workflow("desktop-build").jobs.desktop.steps;
  const packaging = steps.find(({ name }) => name === "Package unsigned application");
  assert.match(packaging.run, /if \[ "\$\{\{ matrix.platform \}\}" = mac \]; then args\+=\(--dir\)/);
  const upload = steps.find(({ name }) => name === "Upload installers");
  assert.equal(upload.if, "matrix.platform == 'win'");
  assert.equal(upload.with.path, "release/*.exe");
  const download = workflow("desktop-ci").jobs.preview.steps.find(({ name }) => name === "Download installers from this run");
  assert.equal(download.with.pattern, "GitCat-*-win-x64-${{ github.sha }}");
});

test("release preparation requires both Windows files and rejects any extra Mac file", () => {
  const step = workflow("desktop-ci").jobs.preview.steps.find(({ name }) => name === "Verify Windows downloads and prepare release notes");
  const script = step.run.split("<<'NODE'\n")[1].split("\nNODE")[0];
  const cwd = mkdtempSync(join(tmpdir(), "gitcat-preview-"));
  const run = () => spawnSync(process.execPath, ["--input-type=module"], {
    cwd, input: script, encoding: "utf8", env: { ...process.env, GITCAT_BUILD_VERSION: "0.1.42", GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "mio-gato-software/gitcat" }
  });
  try {
    mkdirSync(join(cwd, "public-preview"));
    const file = name => join(cwd, "public-preview", name);
    writeFileSync(file("GitCat-0.1.42-win-x64-setup.exe"), "setup");
    assert.notEqual(run().status, 0, "missing portable must block publication");
    writeFileSync(file("GitCat-0.1.42-win-x64-portable.exe"), "portable");
    const success = run();
    assert.equal(success.status, 0, success.stderr);
    const notes = readFileSync(join(cwd, "preview-notes.md"), "utf8");
    assert.match(notes, /Mac downloads are unavailable/);
    assert.equal((notes.match(/^- \[/gm) ?? []).length, 2);
    assert.doesNotMatch(notes, /releases\/download\/[^\s)]+\.(dmg|zip)/);
    writeFileSync(file("GitCat-0.1.42-mac-arm64.dmg"), "unsigned");
    assert.notEqual(run().status, 0, "unexpected Mac files must block publication");
    rmSync(file("GitCat-0.1.42-mac-arm64.dmg"));
    writeFileSync(file("GitCat-0.1.42-win-x64-portable.exe"), "");
    assert.notEqual(run().status, 0, "empty downloads must block publication");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
