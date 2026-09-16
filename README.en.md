# Wenmai Studio

[简体中文](README.md) · [Quick start](docs/getting-started.en.md) · [Architecture](docs/architecture.en.md) · [Operations](docs/operations.en.md) · [Agent access](docs/agent-access.en.md) · [Contributing](CONTRIBUTING.en.md)

Wenmai is a local article workbench for article projects, versions, proposed changes, review, and publication preparation. It uses Vinext/Vite, a Cloudflare Worker, and a local D1 database at the fixed origin `http://[::1]:3000`.

## Capabilities and boundaries

- Organize articles, branches, revisions, work items, proposed patches, review evidence, and publication-preparation records.
- Constrain Agents with roles, capability scopes, short-lived credentials, and auditable receipts; candidate work, approval, merge, and publication are separate.
- Provide local workflow interfaces for Agent Gateway, MCP, Runner, and Model Gateway.
- Platform targets default to `manual` / `not_connected`; no automatic sign-in, sending, or public publication occurs.
- Model Gateway never triggers autonomously. An explicit controlled action sends bounded input to a configured fixed Provider and receives a structured candidate. Configuration or code contracts do not prove connectivity or a successful call.

## Quick start

Node.js `>=22.13` is required.

```sh
git clone <repository-url> wenmai-studio
cd wenmai-studio
npm ci
npm run dev
```

Open `http://[::1]:3000`. See [Getting started](docs/getting-started.en.md) for binding and recovery.

## Tutorial index

| Topic | 简体中文 | English |
| --- | --- | --- |
| Setup, daily work, and tests | [快速开始](docs/getting-started.md) | [Getting started](docs/getting-started.en.md) |
| Components, trust boundaries, and data | [架构](docs/architecture.md) | [Architecture](docs/architecture.en.md) |
| Agent, MCP, Runner, model invocation | [Agent 接入](docs/agent-access.md) | [Agent access](docs/agent-access.en.md) |
| Backup, migration, operation, recovery | [运维](docs/operations.md) | [Operations](docs/operations.en.md) |
| Contribution conventions | [贡献](CONTRIBUTING.md) | [Contributing](CONTRIBUTING.en.md) |

## Common commands

```sh
npm run dev
npm run build
npm run start
npm run lint
npm run test:public
```

`npm run test:public` is the public composite test entry point; `npm test` is equivalent and can build before running multiple contract suites. Topic scripts are in `package.json`; run the relevant one for focused work and proportionate broader checks before merging.

## Security and limitations

This is a local workflow. Do not expose the listener, browser session, or database to an untrusted network. Keep Provider endpoints, credentials, and secrets only in protected server-side environment or local configuration, never in the repository, examples, or task payloads. Publication preparation is not submission acceptance, destination verification, or public visibility; each requires separate evidence.

## License

Public visibility is not an open-source grant. This release is provided under the [Wenmai Source-Available Notice](LICENSE) for review and evaluation only; no right to use, modify, deploy, or redistribute is granted without prior written permission from the copyright holders.
