import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appName = "Branchline.app";
const applicationsDirectory = process.env.BRANCHLINE_APPLICATIONS_DIR || "/Applications";
const architecture = process.arch;
const architectureFlag = architecture === "arm64" || architecture === "x64" ? `--${architecture}` : undefined;
const dryRun = process.argv.includes("--dry-run");

if (!architectureFlag) throw new Error(`Unsupported macOS architecture: ${architecture}`);
if (process.platform !== "darwin" && !dryRun) throw new Error("The macOS installer must run on macOS.");

const source = join(root, "release", `mac-${architecture}`, appName);
const destination = join(applicationsDirectory, appName);
const temporaryDestination = join(applicationsDirectory, `.${appName}.update-${process.pid}`);

function displayToken(token) {
  return /^[A-Za-z0-9._/@:=+~-]+$/.test(token) ? token : JSON.stringify(token);
}

function displayCommand(command, args) {
  return [command, ...args].map(displayToken).join(" ");
}

function run(command, args) {
  console.log(`\n> ${displayCommand(command, args)}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? "unknown"}.`);
}

function installApp() {
  if (!existsSync(source)) throw new Error(`Built app not found at ${source}.`);
  mkdirSync(applicationsDirectory, { recursive: true });
  rmSync(temporaryDestination, { recursive: true, force: true });

  try {
    execFileSync("/usr/bin/ditto", ["--rsrc", "--extattr", source, temporaryDestination], { stdio: "inherit" });
    rmSync(destination, { recursive: true, force: true });
    renameSync(temporaryDestination, destination);
  } catch (error) {
    rmSync(temporaryDestination, { recursive: true, force: true });
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not update ${destination}: ${detail}`);
  }
}

const buildArgs = ["exec", "--", "electron-builder", "--mac", "--dir", architectureFlag, "--publish", "never"];
if (dryRun) {
  console.log(displayCommand("npm", ["run", "build"]));
  console.log(displayCommand("npm", ["run", "icons"]));
  console.log(displayCommand("npm", buildArgs));
  console.log(`${source} -> ${destination}`);
} else {
  run("npm", ["run", "build"]);
  run("npm", ["run", "icons"]);
  run("npm", buildArgs);
  installApp();
  console.log(`Installed ${appName} in ${applicationsDirectory}. Restart Branchline to use the new build.`);
}
