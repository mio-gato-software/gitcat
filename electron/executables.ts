import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";

export function pathEntries(value: string | undefined, platform: NodeJS.Platform = process.platform): string[] {
  return (value ?? "").split(platform === "win32" ? win32.delimiter : posix.delimiter).map((entry) => entry.trim()).filter(Boolean);
}

/**
 * A desktop app launched from Finder or a desktop menu inherits launchd's or the session manager's
 * PATH, not the shell's, so package-manager locations are missing. Git usually survives because
 * /usr/bin/git exists; tools like gh do not.
 */
export function wellKnownToolDirectories(platform: NodeJS.Platform, home: string): string[] {
  if (platform === "win32") return [];
  const { join } = posix;
  const shared = ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", join(home, ".local", "bin"), join(home, "bin")];
  return platform === "darwin"
    ? ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/opt/local/bin", ...shared]
    : ["/var/lib/flatpak/exports/bin", ...shared, join(home, ".linuxbrew", "bin"), "/home/linuxbrew/.linuxbrew/bin"];
}

export function executableNames(name: string, platform: NodeJS.Platform, pathext = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD"): string[] {
  if (platform !== "win32") return [name];
  const extensions = pathext.split(";").map((item) => item.trim()).filter(Boolean);
  return [...new Set([name, ...extensions.map((extension) => `${name}${extension}`)])];
}

export function isExecutableFile(path: string) {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findExecutable(
  name: string,
  directories: string[],
  isExecutable: (path: string) => boolean = isExecutableFile,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (name.includes("/") || name.includes("\\")) return isExecutable(name) ? name : undefined;
  const names = executableNames(name, platform);
  const seen = new Set<string>();
  for (const directory of directories) {
    if (!directory || seen.has(directory)) continue;
    seen.add(directory);
    for (const candidate of names) {
      const full = (platform === "win32" ? win32 : posix).join(directory, candidate);
      if (isExecutable(full)) return full;
    }
  }
  return undefined;
}
