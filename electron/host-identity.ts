export type GhAccount = { login: string; active: boolean };

/**
 * GitHub answers `ssh -T` with "Hi <login>! You've successfully authenticated". Knowing *which*
 * identity answered is the difference between pushing as the intended account and pushing as
 * whichever key happens to be the default one.
 */
export function parseSshGreeting(output: string): string | undefined {
  return output.match(/\bHi\s+([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)[!,]/)?.[1];
}

export function isSshAuthenticated(output: string, exitCode: number | undefined) {
  return exitCode === 0 || /successfully authenticated|shell access is disabled|authenticated to/i.test(output);
}

/** Concrete `Host` aliases from an ssh config; patterns and negations cannot be dialled directly. */
export function sshConfigHostAliases(config: string): string[] {
  const aliases: string[] = [];
  for (const line of config.split("\n")) {
    const match = line.match(/^\s*Host\s+(.+?)\s*(?:#.*)?$/i);
    if (!match) continue;
    for (const alias of match[1].split(/\s+/)) {
      if (alias && !/[*?!]/.test(alias) && !aliases.includes(alias)) aliases.push(alias);
    }
  }
  return aliases;
}

/** `ssh -G <alias>` resolves the effective configuration, including Match and Include directives. */
export function parseSshResolvedHostName(output: string): string | undefined {
  return output.match(/^hostname\s+(\S+)\s*$/im)?.[1]?.toLowerCase();
}

export function parseGhAccounts(json: string, host: string): GhAccount[] {
  try {
    const parsed = JSON.parse(json) as { hosts?: Record<string, { login?: unknown; active?: unknown; state?: unknown }[]> };
    return (parsed.hosts?.[host] ?? [])
      .filter((entry) => typeof entry.login === "string" && entry.state !== "error")
      .map((entry) => ({ login: entry.login as string, active: entry.active === true }));
  } catch {
    return [];
  }
}

export function findAccount(accounts: GhAccount[], login: string) {
  return accounts.find((account) => account.login.toLowerCase() === login.toLowerCase());
}
