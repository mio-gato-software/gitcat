/// <reference types="vite/client" />

import type { GitlineApi } from "../shared/types";

declare global {
  interface Window { gitcat: GitlineApi; }
}

export {};
