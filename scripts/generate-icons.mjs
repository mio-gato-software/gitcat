import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
if (process.platform === "win32") {
  // Windows packaging must not depend on Unix tools or a working GPU context.
  const { Resvg } = await import("@resvg/resvg-js");
  mkdirSync(buildDir, { recursive: true });
  const image = new Resvg(readFileSync(svg), { fitTo: { mode: "width", value: 1024 } }).render();
  writeFileSync(png, image.asPng());
  console.log(`Ícono raster generado con resvg: ${png}`);
  process.exit(0);
}
if (!has("rsvg-convert")) {
  // Packaging prefers icon.png over SVG. Always refresh it, even on a Mac
  // without librsvg, otherwise an old brand icon silently ships again.
  mkdirSync(buildDir, { recursive: true });
  execFileSync(join(root, "node_modules", ".bin", "electron"), [join(root, "scripts", "render-icon.cjs"), svg, png], { stdio: "inherit" });
  console.log(`Ícono raster generado con Electron: ${png}`);
  process.exit(0);
}

mkdirSync(buildDir, { recursive: true });
execFileSync("rsvg-convert", ["-w", "1024", "-h", "1024", "-o", png, svg], { stdio: "inherit" });
console.log(`Ícono raster auxiliar generado: ${png}`);
