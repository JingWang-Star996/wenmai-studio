# Operations, backup, and migration

[简体中文](operations.md) · [Home](../README.en.md)

## Runtime checks

Use `npm ci` for locked dependencies, `npm run dev` for development, and `npm run build` followed by `npm run start` to verify a build. The service is fixed at `http://[::1]:3000`; do not change it to a public listener to work around an access issue.

Before running, confirm the local D1 `DB` binding is available. Providers, browser sessions, and platform connections require independent checks; targets are disconnected by default. Never put secrets in logs, the repository, or backup names.

## Backup

Back up at least a database export or recoverable copy, matching migrations, application version/commit identifier, and needed import artifacts with digests. Store backups in a protected location and periodically verify readability and recovery on an isolated copy. A successful backup is not a successful restore; keep restore-rehearsal evidence.

## Migration and recovery

1. Stop writes or create a consistent snapshot of current state.
2. Copy the target database and run migration on the copy first.
3. Record before/after versions, input digests, commands, and result; run proportionate tests.
4. Change the target only after copy acceptance, retaining a rollback copy.
5. On failure or uncertainty, stop writes, retain evidence, and recover from a known-good copy; do not automatically repeat high-impact steps.

Migration scripts or schema changes need code-owner review. This document does not authorize database deletion, irreversible migration, or external publication.

## Troubleshooting

- **Application will not open:** confirm dependencies, the active development command, and the fixed origin.
- **D1 binding missing:** inspect local runtime configuration; do not substitute a fabricated binding or remote database.
- **Model invocation fails:** record Provider, action, digest, and error. A routing contract does not guarantee availability; return to deterministic or coordinator work first.
- **Submission outcome unclear:** freeze that publication write and probe the destination read-only before any further click.

## Maintenance verification

Run affected `test:*` scripts first, then a risk-proportionate combination of `npm run lint`, `npm run build`, or `npm test`. Passing tests and local readback are not acceptance or public visibility on an external platform.
