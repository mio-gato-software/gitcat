/** Copy preferences once, retaining the originals for rollback. New preferences always win. */
export function migratePreferences(storage: { length: number; key: (index: number) => string | null; getItem: (key: string) => string | null; setItem: (key: string, value: string) => void }): void {
  try {
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
    for (const key of keys) {
      if (!key?.startsWith("branchline-")) continue;
      const next = `gitcat-${key.slice("branchline-".length)}`;
      const value = storage.getItem(key);
      if (value !== null && storage.getItem(next) === null) storage.setItem(next, value);
    }
  } catch { /* Preferences must never prevent opening a repository. */ }
}
