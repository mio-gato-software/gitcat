import { existsSync, copyFileSync, constants } from "node:fs";
import { join } from "node:path";

export const legacyAppName = "branchline";

/** Keep Chromium's existing profile and encrypted credentials in place on upgraded installs. */
export function profilePath(appData: string): string {
  const legacy = join(appData, legacyAppName);
  return existsSync(legacy) ? legacy : join(appData, "gitcat");
}

export function migrateProfileFiles(directory: string): void {
  for (const suffix of ["settings", "workspace", "memory"]) {
    const source = join(directory, `${legacyAppName}-${suffix}.json`);
    const target = join(directory, `gitcat-${suffix}.json`);
    if (existsSync(source) && !existsSync(target)) copyFileSync(source, target, constants.COPYFILE_EXCL);
  }
}
