# Getting started and daily workflow

[简体中文](getting-started.md) · [Home](../README.en.md)

## Install and start

Prepare Node.js `>=22.13`, then run at the repository root:

```sh
npm ci
npm run dev
```

Open `http://[::1]:3000`. If the app reports that the D1 `DB` binding is unavailable, verify the local development configuration supplies it. Do not bypass the error with example secrets or external endpoints.

On the first `dev`, `build`, or `start` in a clean clone, Wenmai creates local indexes containing one synthetic demonstration article from `data/*.example.json`. The bootstrap only fills missing `*.generated.json` files and never replaces an existing article index or capability inventory. Run `npm run data:bootstrap` directly if you want to inspect this step.

## Daily editing loop

1. Create or select an article project and confirm its active branch and work item.
2. Record changes as candidates, revisions, or patches; retain inputs, artifact digests, and review evidence.
3. Let a separate approval step decide whether to accept a candidate, then perform a controlled merge step.
4. Check changes with `npm run lint` and relevant topic tests; run `npm run test:public` for the public full regression (`npm test` is equivalent).
5. Treat publication only as manual preparation: verify the target remains `manual` / `not_connected` and stop before submission unless separate current-batch authorization and a receipt chain exist.

## Build and run

```sh
npm run build
npm run start
```

Use `npm run dev` during development. Do not assume a production binding, Provider, or external platform is configured. Configuration, secrets, and availability require independent runtime verification.

## Choosing tests

`package.json` lists topic `test:*` scripts for Agent access, model routing, Runner, MCP, import, and platform targets. Run scripts matching the change, then `npm run test:public` when preparing integration (`npm test` is equivalent). A passing test proves only its covered contract, never external service availability, sign-in, or publication outcome.

## Next steps

Read [Architecture](architecture.en.md) for trust boundaries, [Agent access](agent-access.en.md) for candidate automation, and [Operations](operations.en.md) for data maintenance.
