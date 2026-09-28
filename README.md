# GitCat

GitCat is a desktop app that helps you understand where your work is in a Git project and what will happen before you change it. You can review files, save selected changes, work on branches, and publish your work without having to start from Git commands. When something goes wrong, GitCat explains the repository's current state and offers a way forward.

I built GitCat for my own use and am sharing the result publicly in case it is useful to others. It is a personal project, not a commercial service. AI tools were used to generate parts of the code; I maintain the project and decide what goes into it.

## What it does

- Shows unsaved changes, local commits, integration into the main branch, and what has been published to a remote as separate states.
- Lets you inspect a diff and choose which **whole files** to include before saving a commit. Unselected files stay in your working folder.
- Opens existing Git repositories, clones projects from HTTPS or SSH addresses, starts tracking a folder, and provides a disposable local practice project.
- Helps you create, switch, rename, and integrate branches; inspect commit history and linked worktrees; and fetch, pull, or push remote changes.
- Guides you through conflicts, interrupted operations, and recovery with visible plans and confirmation before changes are applied.
- Can prepare a GitHub review when the required GitHub tools and access are available.
- Offers its interface in English and Spanish.

The direct Git controls work without an AI account or an internet connection when the action itself is local. Remote operations still need access to the remote.

## Download GitCat

Download the newest preview from the [public Releases page](https://github.com/mio-gato-software/gitcat/releases). Choose the Windows installer or portable executable. No GitHub account is needed to download these release files.

Previews are published automatically after all Windows and Mac checks pass on `main`. Each preview identifies its source commit, includes SHA-256 checksums, and stays available alongside older previews. Windows builds are unsigned, so Windows may display a security warning. Install [Git](https://git-scm.com/) separately.

Mac downloads are unavailable until Developer ID signing, Apple notarization, and Gatekeeper verification are in place. Previous unsigned Mac downloads were withdrawn because macOS can report them as damaged. Mac users can build from source for local use.

## Try it from source

You need [Git](https://git-scm.com/), npm, and Node.js 22 (version 22.13 or later) or Node.js 24+. The development workflow is:

```bash
git clone https://github.com/mio-gato-software/gitcat.git
cd gitcat
npm ci
npm run dev
```

On first launch, choose **Create a practice project** to try editing, saving, branching, and resolving a sample conflict without an account, a remote, or AI. You can also open a folder that already uses Git. GitCat does not require you to move an existing project into a special workspace.

Remote actions use your existing Git access. Sharing a branch for GitHub review also requires the [GitHub CLI](https://cli.github.com/) and a signed-in account.

The app is built for Windows, macOS, and Linux with Electron, React, TypeScript, and Vite. The renderer uses a preload bridge to request operations from the Electron main process, which checks repository state and runs Git. Windows x64 builds have passed the full unit suite, desktop UI and welcome-layout checks, and installed-app startup and local Git checks. macOS is also used for personal development; Linux has not been verified for public distribution.

## Optional AI assistant

You can connect your own OpenAI API key to ask for help in natural language, get explanations, and draft commit descriptions. The assistant proposes a plan for you to review; GitCat validates the operation and runs Git only after the required confirmation. The assistant cannot send an arbitrary shell command for execution.

OpenAI API use is billed by OpenAI to your account. A ChatGPT subscription does not include API usage. Before you use the assistant with a repository, review what will be shared: requests can include file and branch names, recent commit information, unsaved diffs, full contents of new files, and conflicted file contents. GitCat checks for common secret patterns locally, but that check cannot guarantee that a repository contains no sensitive data. The app stores the API key using Electron's secure storage when available and does not save it as plain text when secure storage is unavailable.

The assistant is optional. Saving changes with your own description, branch actions, syncing, and conflict resolution remain available through direct controls.

## Development

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:ui
npm run test:welcome
```

`npm run check` runs the lint, type, unit, and UI checks together. Unit fixtures use disposable Git configuration so personal identity, hooks, signing and line-ending preferences do not change their results. The UI checks build the app and use disposable app profiles; the main UI check also uses disposable repositories. `npm run test:welcome` checks both languages at desktop, compact and zoomed sizes.

### Continuous integration

[Desktop PR checks](https://github.com/mio-gato-software/gitcat/actions/workflows/desktop-pr.yml) runs on pull requests. [Desktop CI](https://github.com/mio-gato-software/gitcat/actions/workflows/desktop-ci.yml) runs on pushes to `main` and can also be started manually. Separate native Windows x64, macOS Apple Silicon, and macOS Intel jobs run lint, type checks, the full test suite, desktop UI and welcome-layout checks, and package the application.

Successful Windows jobs attach unsigned setup/portable executables to the workflow run for 14 days. Mac jobs validate unpacked app builds without uploading downloadable apps. UI screenshots are retained for 7 days to help diagnose failures. Once all three jobs pass on `main`, a separate job publishes both Windows downloads and their checksums as a public GitHub prerelease. It uploads to a draft first, so an interrupted upload is not presented as a complete preview. Pull requests never publish. Re-running a failed job resumes publication of the same version; already published versions are left intact. A new manual run on `main` produces a new version, even for the same commit. Release downloads do not have the Actions artifacts' 14-day expiry.

CI versions use `major.minor.<workflow run number>` (for example, `0.1.42`). Keep `package.json` and its lockfile at `major.minor.0`; only change major/minor intentionally. CI injects the patch through electron-builder's `extraMetadata.version` when packaging, without editing or committing either source file. Help → About, installer filenames, and the public `preview-0.1.42` tag all identify the same version. Every platform in a run shares it, and retries keep it. PR checks use a separate counter. Failed release runs consume numbers, so public previews may have gaps. The counter continues across major/minor changes; keep the Desktop CI workflow identity to preserve it. Version components are checked against Windows' 65535 limit.

Local builds continue to use the source version unless a version override is explicitly passed to electron-builder. To install an exact CI version, download its installer from the workflow artifacts or the public Releases page.

The workflow does not install anything on your computer. Personal Windows installation remains part of the local delivery workflow.

`npm run package:dir` creates an unpacked local build. Packaging scripts for macOS, Windows, and Linux are in `package.json`. The macOS packaging scripts currently produce unsigned builds; I do not have a signing certificate or notarized public release.

On Windows, run `npm run dist:win` to create both an installer (`release/GitCat-<version>-win-<arch>-setup.exe`) and a portable app (`release/GitCat-<version>-win-<arch>-portable.exe`). The portable app runs without installation. Windows builds are unsigned and require Git to be installed separately.

## Contributions and support

I'm not accepting external contributions or pull requests for now. I may change that later. This is a personal project, so there is no support commitment or guaranteed response time.

## License

GitCat is released under the [MIT License](LICENSE).
