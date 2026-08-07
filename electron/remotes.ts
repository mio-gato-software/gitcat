/**
 * Where each remote actually points. The interface listed remote *names* and the word "configured",
 * which says nothing anyone needed — but which URL a push would reach is a real question on a machine
 * with more than one account, and it had no answer anywhere in the app.
 */
export function parseRemoteUrls(raw: string): Record<string, string> {
  const urls: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const [name, rest] = line.split("\t");
    if (!name || !rest) continue;
    const url = rest.replace(/\s*\((fetch|push)\)\s*$/, "").trim();
    // Fetch is listed first and is the one a read follows, so it wins when the two differ.
    if (url && !urls[name]) urls[name] = url;
  }
  return urls;
}
