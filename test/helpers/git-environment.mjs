import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fixtures must not inherit an owner's identity, hooks, signing or line-ending settings.
// Tests that exercise global configuration can replace this disposable config.
const directory = mkdtempSync(join(tmpdir(), "gitcat-test-config-"));
const config = join(directory, "config");
writeFileSync(config, "[core]\n\tautocrlf = false\n");
process.env.GIT_CONFIG_GLOBAL = config;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_COUNT = "0";
process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
