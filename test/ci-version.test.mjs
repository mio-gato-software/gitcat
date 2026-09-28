import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ciVersion } from "../scripts/ci-version.mjs";

test("every new CI run advances the patch while keeping the chosen major/minor", () => {
  assert.equal(ciVersion("0.1.0", "42"), "0.1.42");
  assert.equal(ciVersion("0.1.0", "43"), "0.1.43");
  assert.equal(ciVersion("1.2.0", "44"), "1.2.44");
});

test("CI version is identical across platforms and retries without editing source metadata", () => {
  const files = [new URL("../package.json", import.meta.url), new URL("../package-lock.json", import.meta.url)];
  const before = files.map((file) => readFileSync(file));
  const base = JSON.parse(before[0].toString()).version;
  const script = fileURLToPath(new URL("../scripts/ci-version.mjs", import.meta.url));
  for (const [os, attempt] of [["Windows", "1"], ["macOS", "1"], ["macOS", "2"]]) {
    const version = execFileSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_RUN_NUMBER: "42", GITHUB_RUN_ATTEMPT: attempt, RUNNER_OS: os }
    }).trim();
    assert.equal(version, ciVersion(base, "42"));
  }
  for (const [index, file] of files.entries()) assert.deepEqual(readFileSync(file), before[index]);
});

test("invalid counters and versions fail instead of producing broken Windows installers", () => {
  for (const number of [undefined, "", "0", "-1", "1.5", "01", "42\n", "65536", "9007199254740993"]) {
    assert.throws(() => ciVersion("0.1.0", number));
  }
  for (const base of ["0.1.7", "0.1.0-beta", "1.2", "01.2.0", "65536.0.0"]) {
    assert.throws(() => ciVersion(base, "42"));
  }
  assert.equal(ciVersion("1.2.0", "65535"), "1.2.65535");
});
