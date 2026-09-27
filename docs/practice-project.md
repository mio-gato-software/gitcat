# Disposable practice projects

Welcome and the lightbulb beside Settings create an explicitly disposable project under GitCat's
private profile. It has no remote, uses GitCat Practice <practice@example.invalid>, disables hooks
and signing, and initializes with an empty template and isolated system/global Git configuration.
No AI or account is needed. The normal workspace restores it like any other open project.

Six skippable lessons explain working files, a commit as a local saved version, a branch as a line
of work, local integration, a real prepared conflict and recovery. All save/branch/merge/conflict
choices use the existing review and confirmation paths. The guide reports the actual branch,
unsaved-file count and conflicts instead of declaring a lesson complete from a click. Lesson
selection is stored locally and survives restart. Replay creates another practice, preserving the
old one; cleanup requires explicit confirmation for that entire disposable folder.

Demo edits append only to story.txt in a verified practice folder. Ownership requires a registry
entry, matching random marker, an immediate child of the managed root and a real .git directory.
Symlinked folders, markers, Git directories and sample files are refused. Cleanup cannot target
the managed root or an unregistered personal project. Deletion does not follow child symlinks.

Practice blocks network operations and global identity changes through GitCat, even when someone
adds a remote externally. Fetch and readiness do not contact that remote or check accounts. The
assistant is optional, and no exercise calls it automatically. Normal personal projects retain
all their existing capabilities.

Automated checks cover isolated initialization, lesson persistence/replay, ownership/symlink
refusals, append/save/branch/integration and a real conflict resolved through the existing guide.
