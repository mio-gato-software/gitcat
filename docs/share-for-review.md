# Share for review

The paper-plane control beside Settings opens a dedicated GitHub review flow for the selected
local branch. Choose a remote, head, remote base, title and description. Check reads fresh GitHub
status and previews the verified account, destination, commits still needing publication and any
existing open/closed/merged review. These are live API results, separate from graph PR references
parsed from commit messages. Checking does not publish.

Confirmation rechecks the branch hashes, remote URL, base and account. Git push and gh must be
proven to use the same active account through the existing readiness/identity checks. GitCat does
not switch accounts, infer an identity, force-push, merge the review or bypass protections. A push
uses the exact reviewed commit and destination branch, leaving working files and other branches
untouched. Existing open reviews are reused; a closed/merged review is displayed as such and a
new review is created only for commits still ahead of the chosen base.

This first version supports GitHub.com and one matching fetch/push destination. Other hosts,
offline states, missing gh, account mismatches and permission denials offer guidance without
claiming publication. If publication succeeds but review creation/status fails, the error says
that the branch may already be published. Check live status before retrying. The normal local
save/integrate workflow is unchanged. Confirmed push/PR creation is recorded in activity history.
