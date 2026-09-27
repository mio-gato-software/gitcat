# GitCat public portfolio release plan

Planning document prepared 2026-09-27 against `99ad341`.
This proposes a scope; it does not authorize publication, adopt a license, commit
spending, or announce a release date. Personal use remains the current model.

## Audience and product story

Make a useful tool and the engineering decisions behind it easy to evaluate.
The primary audience is an individual developer on a Mac who needs to save work,
try an idea on a branch, and recover from mistakes. The secondary audience is a
prospective collaborator evaluating the owner's product and engineering judgment.

Suggested opening: “GitCat helps you see where your work is, review a change before
saving it, and understand what will happen before Git changes your project. Use
the direct workflows without AI, or connect an optional assistant to plan an action.”

Demonstrate selected-file saves, reviewed branch integration, and recovery with
visible effects. Mention GitHub review sharing as an optional team workflow.
Rebase and natural-language commands are supporting features. Do not claim proven
beginner usability: observed testing with consenting participants is still needed.

## Current evidence and release gaps

| Area | Evidence at the reviewed commit | Remaining work |
| --- | --- | --- |
| Workflows | Save, branches, conflicts, recovery, review sharing and offline practice | Exercise the whole demo on a clean installed profile |
| Checks | 373 tests, lint, typecheck, build and Electron UI checks passed locally | Repeat from a clean checkout for the exact release commit |
| README | Spanish development instructions; opening emphasizes the original branch/rebase MVP | Clear English entry point with Spanish link, media, installation and limits |
| Packaging | Electron 43.3.0, builder 26.15.3, DMG/ZIP targets; personal installer uses host architecture | Separate public signing/notarization from the unsigned personal installer |
| License | No top-level LICENSE; private package metadata has no license field | Ownership review, license adoption and metadata |
| Dependencies | Four production lockfile entries declare MIT/ISC; React and React DOM are MIT, Lucide is ISC | Actual license texts, shipped transitive components, Electron/Chromium notices and artwork provenance |
| History | 129 tracked files and 92 commits reachable from local refs; filename-only screening found no obvious secret-file names | Full content/history and remote-ref audit; filenames do not establish publication safety |
| Support | No tracked contribution/security policy or public release workflow | Concise policies and repeatable release checks |

## Sequence and scope limits

The owner decides and maintains the project. These are suggested effort ceilings,
not deadlines. When a phase exceeds its ceiling, record the blocker and reassess.

| Order | Deliverable | Suggested ceiling | Completion gate |
| --- | --- | --- | --- |
| 1 | Publication review and proposed license | Two focused sessions | Intended public refs/assets reviewed, notices identified, owner records licensing and visibility decision |
| 2 | README, three screenshots, demo and case study | Two focused sessions | A reader can understand one useful workflow and its limits without a call |
| 3 | Mac preview package and verification record | Two focused sessions, then reassess | Signed/notarized artifact passes fresh-machine checks; version, checksum and notes are ready |
| 4 | Small launch and feedback review | One launch session and one review session | Owner authorizes publication; feedback recorded; at most three follow-ups prioritized |

If signing access or another Mac is unavailable, finish the source/demo materials
and record the distribution blocker. Do not substitute disabling Gatekeeper.
A source-only preview would be a separate owner decision.

## License, publication review and dependencies

Recommend MIT for owner-controlled source: it fits the goal of reuse and
collaboration and requires retaining its copyright/license notice. This remains
a proposal until ownership and the correct copyright holder are established.
[MIT license reference](https://choosealicense.com/licenses/mit/).

Use a separate audit checkout, fetching every branch/tag intended for release.
Scan current files and historical blobs for secrets and inspect findings locally,
redacting values from reports. Review commit identities, private paths and URLs,
screenshots, fixtures, provider transcripts, copied code and generated assets.
Add deliberate secret-file ignore patterns before accepting outside contributions.
Do not upload private history to a third-party scanner by default.

If credentials are found, rotate them before proposing history cleanup. Preserve
a private backup and decide between audited history and a clean public snapshot.
A snapshot must retain required attribution. No history rewrite or force push is
part of this planning task.

Inventory the lockfile and actual packaged app, including Electron/Chromium,
fonts and icons. Check license texts, preserve required notices in source and
artifacts, and review dependency vulnerabilities for applicability. Record fixes
or accepted limits against the release commit. The preliminary metadata inventory
above is not a completed license/security audit.

## README, media and case study

The future README should present the product story, audience, captioned demo,
tested Mac/architecture versions, download/verification, Git and optional GitHub
CLI prerequisites, three common workflows, optional AI costs/data disclosure,
known limits, development commands, contribution/security contacts and license.
Keep unsupported platform scripts in developer notes so they do not imply tested binaries.

Use a disposable project, invented names and a clean profile. Capture three
readable laptop-sized screenshots with alt text: work overview and next action;
selected files with diff/save confirmation; activity and a reviewed recovery result.

Record a 60–90 second captioned demo: create a practice project, edit, review and
save, create an idea branch, integrate its saved work, then inspect activity and
preview recovery. Explain local saving versus publication. Show actual outcomes
and disclose cuts. Use no personal remote or paid AI call. A separate team-review
clip can follow only if feedback calls for it.

Write a 700–1,000 word case study with links to source and tests:

- Problem and constraints: daily personal use, beginner confidence, optional AI,
  and a small maintenance budget.
- Architecture: React, trusted preload/IPC, service validation and Git execution;
  why visible plans precede mutations.
- Safety/recovery: fresh snapshots, uncommitted work, partial operations,
  publication checks and limits of undo.
- Tradeoff: cooperative cancellation lets an active mutation settle, stops later
  steps, and reports the resulting repository state.
- Evidence: reproducible fixtures, regressions and UI checks; separate automated
  evidence from unfinished observed usability work.
- AI assistance: actual coding/review assistance, the owner's decisions and
  verification, plus a limitation exposed by testing.

Use the existing activity, unfinished-work, progress, sharing, practice and
accessibility documents as evidence. Do not invent user results or independent audits.

## Minimum Mac distribution

Propose an Apple Silicon preview first. Record the minimum macOS version and test
matrix before release, based on the pinned Electron version and real machines.
Intel, Windows and Linux remain source-build experiments until someone can test
them. No Mac App Store launch is needed.

Create a separate release configuration with a Developer ID Application identity,
appropriate hardened-runtime entitlements and notarization. Current scripts set
`CSC_IDENTITY_AUTO_DISCOVERY=false`; today's `dist:mac` is not a verified public
release pipeline. Use builder 26 configuration, not newer schema examples. Keep
signing material in protected release secrets outside the repository. Follow the
versioned [builder macOS documentation](https://www.electron.build/v26/docs/mac/)
and [Electron signing guide](https://github.com/electron/electron/blob/main/docs/tutorial/code-signing.md).

For the exact candidate, run `npm ci` and `npm run check`, package DMG/ZIP, verify
the signature, notarization ticket and Gatekeeper assessment, and generate
SHA-256 checksums. Test a downloaded/quarantined copy on another Mac with a fresh
profile: install, first launch, Git prerequisites, practice/save/conflict/recovery,
restart and upgrade with settings/repository work preserved. Retain commands,
OS/architecture and actual outcomes in a release verification record.

Use manual versioned downloads initially. Automatic updates can wait until their
integrity and recovery paths can be maintained. Keep a previous verified artifact
available and check data compatibility before recommending a downgrade.

## Support, contribution and launch

Proposed maintenance budget: one short triage session per week and at most two
hours of routine support. Prioritize potential data loss/security and broken core
workflows. If the budget is repeatedly exceeded, pause features and narrow scope.
Promise no response time or custom integration work.

Add contribution guidance for focused problem statements, small changes, relevant
regressions and `npm run check`; discuss large features before implementation.
Use issues for reproducible bugs with redacted logs. Select and verify a private
security-reporting channel before launch. Discourage credentials and personal
repository contents in reports.

After the gates and explicit owner authorization, publish one versioned GitHub
release and one portfolio post linking the demo/case study. Invite a small number
of willing peers to try disposable projects; obtain participation before scheduling.
Do not bulk-message communities. Collect voluntary reports without launch telemetry.

Review the first month once: returning users reporting real work, specific friction,
useful professional conversations and actionable contributions. Track support
time too. Downloads/stars provide context, not proof of usefulness. Select at most
three follow-ups and defer the rest.

Payments, subscriptions, hosted AI, team accounts, broad platform promises and
marketing automation are outside the first release. Consider optional support
income only if users request it and maintenance remains sustainable.

## Decisions before executing the plan

This document records the plan. Execution still requires decisions on publication,
copyright/license adoption, public history, signing credentials/budget, verified
platform versions and support contact. Missing beginner sessions block usability
claims, not this planning artifact. No signing evidence or public release is claimed.
