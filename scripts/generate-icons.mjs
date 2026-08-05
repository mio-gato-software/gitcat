import { existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(root, "build");
const svg = join(buildDir, "icon.svg");
const png = join(buildDir, "icon.png");

function has(command) {
  try { execFileSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" }); return true; } catch { return false; }
}

if (!existsSync(svg)) throw new Error(`No existe ${svg}`);
if (!has("rsvg-convert")) {
  console.warn("rsvg-convert no está disponible; electron-builder usará build/icon.svg directamente.");
  process.exit(0);
}

mkdirSync(buildDir, { recursive: true });
execFileSync("rsvg-convert", ["-w", "1024", "-h", "1024", "-o", png, svg], { stdio: "inherit" });
console.log(`Ícono raster auxiliar generado: ${png}`);
