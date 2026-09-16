import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  createCodexNativeSmokePacket,
  createCodexNativeSmokeEnvelope,
  sha256Utf8,
  validateCodexNativeSmokeResult,
} from "../app/codex-native-smoke-contract.ts";

function usage() {
  throw new Error("usage: codex-native-smoke.mjs prepare <workUnitId> | validate <packetPath> <resultPath>");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profilePath = resolve(root, "..", ".codex", "agents", "wenmai-fast-worker.toml");
const currentProfileSha256 = async () => sha256Utf8(await readFile(profilePath, "utf8"));

const [command, ...args] = process.argv.slice(2);
if (command === "prepare" && args.length === 1) {
  const options = { profileSha256: await currentProfileSha256() };
  const packet = createCodexNativeSmokePacket(args[0], options);
  process.stdout.write(`${JSON.stringify(createCodexNativeSmokeEnvelope(packet, { expectedProfileSha256: options.profileSha256 }))}\n`);
} else if (command === "validate" && args.length === 2) {
  const summary = validateCodexNativeSmokeResult(await readJson(args[0]), await readJson(args[1]), { expectedProfileSha256: await currentProfileSha256() });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} else {
  usage();
}
