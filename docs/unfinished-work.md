# Switching with unfinished work

Branch switch controls read the latest repository before acting. With edits, GitCat offers staying
here, reviewing a selected save on the current branch, carrying compatible edits after review, or
setting tracked work aside with a name and an explicit choice about untracked files. Ignored files
are never included. Dirty submodules need their own save/set-aside inside the submodule.

Every carry or set-aside choice becomes an ordinary confirmed plan bound to the reviewed state.
Conflicting files and untracked collisions are explained before a switch; occupied worktrees name
the folder to open. There is no implicit stash, commit, discard, or forced checkout.

The set-aside button beside activity history reads Git's persistent stash entries named by GitCat.
A restart or a stopped sequence can leave a saved entry before the branch switch; it remains
available. Restoring uses `stash apply --index` and never pops the entry. It preserves staged state
when Git can apply it, explains conflicts through the existing recovery flow, and refuses to mix
with unrelated dirty work. Entries remain until removed explicitly with Git; app activity retention
controls do not remove them.
