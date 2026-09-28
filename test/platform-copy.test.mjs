import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
function loadSource(name, globals = {}, extra = "") {
  const source = readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8") + extra;
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX
  } });
  const exports = {};
  runInNewContext(outputText, { require, exports, ...globals });
  return exports;
}
const { en, es, translate } = loadSource("i18n.ts", {}, "\nexport { en, es };\n");
const window = { gitcat: { platform: "win32" } };
const { ReadinessChecklist } = loadSource("Readiness.tsx", { window });

test("both languages keep shared copy neutral and isolate genuine macOS labels", () => {
  const specific = new Set(["readinessGit_installMac", "readinessHelper_osxkeychain"]);
  for (const [locale, messages] of Object.entries({ en, es })) {
    for (const [key, value] of Object.entries(messages)) {
      if (!specific.has(key)) assert.doesNotMatch(value, /\bMac\b|macOS|Apple|xcode-select|osxkeychain|Finder/, `${locale}.${key}`);
    }
  }
  for (const path of ["electron/git-service.ts", "electron/llm-plan.ts", "shared/plan-summary.ts"]) {
    assert.doesNotMatch(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), /\bMac\b/, path);
  }
});

test("Git setup renders Apple tools only on macOS in both languages", () => {
  for (const platform of ["win32", "linux", "darwin"]) for (const locale of ["en", "es"]) {
    window.gitcat.platform = platform;
    for (const status of ["missing", "unusable"]) {
      const html = renderToStaticMarkup(createElement(ReadinessChecklist, {
        t: translate(locale), items: ["git"], readiness: { loading: false, recheck: () => {}, report: { git: { status, detail: "cannot start" } } }
      }));
      assert.match(html, /git-scm\.com|Git/);
      if (platform === "darwin") assert.match(html, /xcode-select --install/);
      else assert.doesNotMatch(html, /\bMac\b|macOS|Apple|xcode-select|osxkeychain/);
    }
  }
});

test("HTTPS sign-in never prescribes macOS Keychain and keeps GitHub CLI guidance", () => {
  for (const platform of ["win32", "linux", "darwin"]) for (const locale of ["en", "es"]) {
    window.gitcat.platform = platform;
    for (const host of ["github.com", "gitlab.com"]) {
      const html = renderToStaticMarkup(createElement(ReadinessChecklist, {
        t: translate(locale), items: ["remote"], readiness: { loading: false, recheck: () => {}, report: {
          git: { status: "ok" }, repoPath: "/project", remote: {
            status: "configured", name: "origin", protocol: "https", host, url: `https://${host}/owner/repo.git`,
            access: "credentials", source: "only", remotes: ["origin"]
          }
        } }
      }));
      assert.doesNotMatch(html, /credential\.helper osxkeychain|xcode-select/);
      if (host === "github.com") assert.match(html, /gh auth login/);
      else assert.doesNotMatch(html, /gh auth login/);
    }
  }
});
