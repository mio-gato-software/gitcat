# Local activity and recovery

Activity and recovery (the clock beside Settings) persists confirmed plans and conflict choices
in the local profile, using atomic private-file replacement. It records timestamps, operation
kinds, status and before/after branch and commit references. It does not retain file contents,
command output, commit messages, credentials, or assistant conversations. Failure text passes
through the existing credential redactors. Entries expire after 30 days by default (7/30/90 days
or off); Clear removes only this project's metadata. Off clears all activity metadata.

A process interrupted between records leaves pending/unknown steps. The UI never treats these
as rollback or automatically replays them. Git's current repository state is authoritative.
This is not a checkpoint of uncommitted files or the index. Files never saved in Git cannot be
restored here. Existing Git references may also eventually be pruned by Git.

Recovery is prepared as a normal confirmable, state-bound plan:

- Create a new recovery branch at the prior commit, without switching or overwriting a branch.
- Revert a single-parent saved commit with a new commit, preserving shared history.
- Undo the latest single-parent save with `reset --soft`, only with no unrelated dirty work,
  no pending operation and no containing configured remote branch/tag. Remote checks are
  refreshed again before execution; network failures block this option. Files and index stay
  byte-for-byte intact. Other people or deleted/unconfigured remotes may still have the commit;
  if it was shared, use revert. No hard reset or force push is presented as safe Undo.

Initial and merge commits require a specific recovery plan instead of an inferred mainline.
