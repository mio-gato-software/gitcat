import { readFile as read } from "node:fs/promises";

// Source contracts concern content, independent of Git's checkout line endings.
export async function readFile(path, encoding) {
  const value = await read(path, encoding);
  return typeof value === "string" ? value.replace(/\r\n/g, "\n") : value;
}
