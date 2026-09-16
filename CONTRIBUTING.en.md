# Contributing

[简体中文](CONTRIBUTING.md) · [Home](README.en.md)

## Before you begin

Use Node.js `>=22.13` and run `npm ci` at the repository root. Read [Getting started](docs/getting-started.en.md), [Architecture](docs/architecture.en.md), and [Agent access](docs/agent-access.en.md). Keep changes focused and do not overwrite another contributor's uncommitted work.

## Change flow

1. State the goal, allowed files, and verification method.
2. Understand existing contracts, routing, and data boundaries before making the smallest change.
3. For code, run relevant `test:*`, `npm run lint`, or build checks; for docs, check links and examples.
4. Describe changes, validation run, and remaining risk.

Never commit secrets, real account data, Provider endpoints, browser sessions, or unsanitized article snapshots. Never elevate Agent output directly into approval, merge, or publication results.

## Documentation conventions

Write prerequisites, commands, boundaries, and reproducible steps for an unfamiliar developer. Chinese and English documentation must be semantically equivalent and cross-linked; use relative paths and cross-platform commands. When a fact needs runtime confirmation, say so. Do not present a code contract or static configuration as external connectivity, automatic publication, or public visibility.

## Before submission

Confirm new relative links exist, the fixed origin remains `http://[::1]:3000`, targets remain accurately described as `manual` / `not_connected`, and candidate, approval, merge, and publication have not been collapsed into one permission.
