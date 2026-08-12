# Release stability gate

This gate applies before PinK Icon Submit is pointed at the production icon
repository. Passing the feature flow in an automation repository is necessary,
but it is not a production-readiness signal by itself.

## Scope

Must complete in this phase:

- preserve database and upload consistency across submit, Worker and restart;
- allow exactly one service instance to own a data directory;
- bound Git, GitHub, npm and Stage 1 operations;
- keep deployment secrets out of child processes that do not own them;
- support HTTPS same-origin requests through an explicit public origin;
- drain an active Worker operation during planned shutdown;
- provide a repeatable production build/start, backup and restore procedure;
- exercise failure checkpoints and a sustained test-repository run.

May be added later:

- administrator UI, self-service registration and password recovery;
- notifications, advanced history filters and multiple active workbenches;
- horizontal API or Worker scaling.

Explicitly excluded:

- changing the production icon repository configuration;
- automatic merge, force-push or direct writes to the target default branch;
- redesigning Stage 1, mapping, codepoints or icon repository layout.

## Required evidence

| Area | Required result |
| --- | --- |
| Clean build | A clean checkout can install, check, test, build and start the production entrypoint. |
| Feature flow | Add, replace, delete, mixed batch, correction and resubmission still create one Draft PR in the test topology. |
| State atomicity | A failed state transition cannot leave job and batch states disagreeing. |
| Upload consistency | A failed or concurrent edit cannot pair old item metadata with new SVG bytes. |
| Single ownership | A second process cannot recover or consume jobs from the same data directory. |
| Shutdown | SIGINT/SIGTERM stops new polling and waits for the active bounded Worker operation. |
| Deadlines | Hung Git, GitHub, npm and Stage 1 operations fail with diagnostics and release the queue. |
| Remote recovery | Pre-push failure, lost push response and lost PR response each recover to one branch and one Draft PR. |
| Upgrade | Supported legacy schemas upgrade to the current schema; newer unknown schemas fail closed. |
| Backup | A stopped service backup restores accounts, sessions, batches, uploads, jobs and delivery evidence in an isolated directory. |
| HTTPS | Login and authenticated writes succeed through the documented HTTPS same-origin deployment path. |
| Secrets | Tokens and bootstrap passwords do not enter logs, child environments, command arguments, URLs or persisted data. |
| Soak | Repeated test-repository batches complete without a stuck queue, duplicate branch or duplicate PR. |

The production repository may be configured only after every applicable row is
proven and the remaining rows are explicitly marked not required with evidence.
The operational sequence and rollback boundary are defined in
[the release candidate runbook](./release-candidate-runbook.md).
