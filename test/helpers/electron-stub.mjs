import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Minimal stand-in so the Git service can be exercised outside a running Electron app.
const userData = mkdtempSync(join(tmpdir(), "gitcat-userdata-"));

export const app = { getPath: () => userData };
export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, "utf8"),
  decryptString: (buffer) => buffer.toString("utf8")
};
export default { app, safeStorage };
