# Agent, MCP, Runner, and Model Gateway

[简体中文](agent-access.md) · [Home](../README.en.md)

## Three local role keys

- `content-steward`: inventories the full repository read-only and may only create, update, or cancel tasks. It cannot produce candidates or replace approval or publication authorization.
- `article-worker`: may work across the repository, but must bind to an existing task and submit candidates only; it cannot approve, merge, or publish.
- `local-registrar`: registers new root articles only at `http://[::1]:3000`. It cannot enumerate, read bodies, or overwrite; it may read back bounded status only with an exact `articleId` and `bodySha`.

Role keys should be short-lived, least-privilege, revocable, and bound to the fixed loopback origin. Do not mix candidate roles with approval, merge, or publication capabilities in one key. Privileged roles must exactly match their code contracts.

## Agent Gateway and MCP

Agent Gateway is the local coordination entry point, carrying identity, scope, and task boundaries into controlled operations. It grants no new permission and calls no model itself. MCP validates token, scope, and article boundaries. Callers must retain requests and receipts; failures or uncertain states must not be disguised as success by retry logic.

## Runner

Runner executes only registered local steps. Every execution should be associated with a lease, input digest, allowed command, and receipt. Never compose a shell command directly from natural language, web content, or Agent output. Local Runner success does not imply an external-platform state.

## Model Gateway

Model Gateway never triggers autonomously. An explicit controlled action sends bounded input to a configured Provider under a fixed Provider contract and receives a structured candidate. A Provider name, route code, or environment-variable template does not establish real connectivity. Keep deterministic checks in code. Only frozen-input, fixed-schema, low-risk, candidate intermediate work may reach a configured Provider; ambiguous judgment, rewriting, high-risk actions, and completion claims remain with a coordinator.

## External actions

Targets are `manual` / `not_connected` by default. Publication preparation, submission acceptance, destination readback, and public visibility are distinct states. External submission needs explicit current-batch human authorization, a one-time capability, single consumption, and later readback. When an outcome is unclear, probe read-only first and never submit automatically a second time.
