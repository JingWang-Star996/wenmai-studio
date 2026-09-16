# Architecture and trust boundaries

[简体中文](architecture.md) · [Home](../README.en.md)

## Components

`app/` is the Vinext/Vite UI and route layer; `worker/` is the Cloudflare Worker entry point with security response headers; `db/` models the Cloudflare D1 binding with Drizzle. `npm run dev` starts at fixed `http://[::1]:3000`.

The model includes articles, branches, revisions, work items, Agent runs, Runner leases, command receipts, merge proposals, publication capabilities, and consumption records. A record alone does not prove an external action completed.

```text
Browser/UI -> local API and workbench -> D1
                                  -> Agent Gateway / MCP / Runner
                                  -> Model Gateway (explicit actions only)
                                  -> platform preparation (manual, disconnected by default)
```

Each layer forwards only inputs it validated and checks identity, scope, artifact digest, expiry, and receipts at boundaries. Downstream output is evidence to verify, not automatic authorization.

## Agent, Runner, and model

Agent Gateway coordinates constrained local Agent flows; it does not choose or call a model for an Agent. MCP resources and tools are constrained by token, scope, and article boundaries. Runner executes only registered local steps with leases and receipts; arbitrary text is never a command.

Model Gateway uses deterministic routing and never triggers autonomously: only an explicit controlled action sends bounded input to a configured fixed Provider and receives a structured candidate. Code handles hashes, schemas, and fixed formats; only low-risk candidate tasks with frozen inputs and explicit output contracts may use that Provider; ambiguous judgment, rewriting, high-risk action, and completion claims remain with a coordinator. Provider secrets, configuration, and connectivity are runtime concerns, and a code contract is not availability proof.

## Candidate, approval, merge, publication

An article worker may propose a candidate or patch, but a candidate is not approval. Approval, merge preparation/execution, and publication-capability consumption remain separate with their own identities, scopes, and receipts. `prepare` stops before submission. Targets are `manual` / `not_connected` by default; do not infer automatic submission or public state.

## Data boundary

D1 is working state. Keep code, migrations, database backups, and import sources separately and verify each. Rehearse migration on a recoverable copy, record input version and result, then change the target database; see [Operations](operations.en.md). A fixed loopback origin is not an identity system and cannot replace network isolation or secret management.
