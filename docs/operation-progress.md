# Operation progress and stopping

The main process owns operation IDs, repository scope, start time, phase and step counters.
The renderer displays elapsed seconds, never an inferred completion percentage. Clone counters
come directly from recognized Git progress messages; arbitrary remote output is not broadcast.

AI requests and read-only subprocesses are abortable. An aborted or late planning response is
never remembered as a plan. Cancelling restores the assistant draft and does not start recovery
AI calls. Duplicate tracked work for the same repository is rejected before entering its queue.
A renderer reload can query active operations; switching tabs shows only that project's work.

A confirmed Git sequence uses cooperative stopping: its current step finishes, subsequent steps
remain skipped, and GitCat reads the final snapshot. A stop request is not rollback and the last
step may complete the entire plan before the stop arrives. Completed/skipped step reports are
authoritative. Fetch similarly settles and reads the repository rather than being killed by a
user stop. Clone has its existing cancellable, owned-staging-directory cleanup path.

Timeouts terminate the subprocess group, wait for exit, then report the timeout. Execution reads
the resulting snapshot before returning a partial failure. A timeout does not establish that a
remote rejected a push: verify remote state before retrying. No force push or rollback is implied.
