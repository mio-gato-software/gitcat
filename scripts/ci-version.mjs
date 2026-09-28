import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** One immutable version per workflow run, shared by every platform and retry. */
export function ciVersion(baseVersion, runNumber) {
  const base = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.0$/.exec(baseVersion);
  if (!base) throw new Error("Keep the source version in major.minor.0 form; CI supplies the patch number.");
  if (typeof runNumber !== "string" || !/^[1-9]\d*$/.test(runNumber)) {
    throw new Error("GITHUB_RUN_NUMBER must be a positive integer.");
  }
  // Windows executable version components are unsigned 16-bit integers.
  if ([base[1], base[2], runNumber].some((part) => Number(part) > 65535)) {
    throw new Error("CI version components must not exceed 65535 (Windows version limit).");
  }
  return `${base[1]}.${base[2]}.${runNumber}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  console.log(ciVersion(version, process.env.GITHUB_RUN_NUMBER));
}
