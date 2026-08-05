import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "dist-electron");

if (process.argv.includes("--copy")) {
  mkdirSync(join(output, "electron"), { recursive: true });
  copyFileSync(join(root, "electron/preload.cjs"), join(output, "electron/preload.cjs"));
} else {
  rmSync(output, { recursive: true, force: true });
}
