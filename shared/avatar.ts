/**
 * Where a commit author's published photo lives, if anywhere. A GitHub no-reply address names its
 * account; any other address is looked up on Gravatar by its SHA-256 hash, so the address itself never
 * leaves the machine. Gravatar is asked to answer 404 rather than a placeholder, so an author without
 * a photo keeps their initials.
 */
export function avatarKey(email: string) {
  return email.trim().replace(/^<|>$/g, "").toLowerCase();
}

export async function authorAvatarUrl(email: string): Promise<string | undefined> {
  const key = avatarKey(email);
  if (!key.includes("@")) return undefined;
  const github = /^(?:(\d+)\+)?([^@+]+)@users\.noreply\.github\.com$/.exec(key);
  if (github) return github[1]
    ? `https://avatars.githubusercontent.com/u/${github[1]}?s=80`
    : `https://avatars.githubusercontent.com/${encodeURIComponent(github[2])}?s=80`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `https://www.gravatar.com/avatar/${hash}?s=80&d=404`;
}
