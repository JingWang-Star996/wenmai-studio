import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const root = new URL("../", import.meta.url);

test("0031 is the single local vNext migration and contains the reduced RSI schema", async () => {
  const journal = JSON.parse(await readFile(new URL("drizzle/meta/_journal.json", root), "utf8"));
  const names = (await readdir(new URL("drizzle/", root))).filter((name) => /^003[1-9].*\.sql$/u.test(name));
  assert.equal(names.length, 1);
  assert.equal(journal.entries.at(-1).idx, 31);
  assert.equal(journal.entries.at(-1).tag, names[0].replace(/\.sql$/u, ""));
  const sql = await readFile(new URL(`drizzle/${names[0]}`, root), "utf8");
  for (const table of ["annotation_rsi_rule_candidates", "annotation_rsi_baseline_revisions", "annotation_rsi_due_checks"]) assert.ok(sql.includes("CREATE TABLE `" + table + "`"));
  assert.doesNotMatch(sql, /review_queue|gate_attestation|shared_source_container/u);
  assert.match(sql, /annotation_rsi_baseline_revisions_immutable_update/u);
});

test("reduced migration executes against a temporary SQLite database", async () => {
  const names = (await readdir(new URL("drizzle/", root))).filter((name) => /^0031.*\.sql$/u.test(name));
  const sql = await readFile(new URL(`drizzle/${names[0]}`, root), "utf8");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE package_source_refs(id TEXT,package_id TEXT); CREATE TABLE human_annotations(id TEXT PRIMARY KEY);");
  for (const statement of sql.split("--> statement-breakpoint").map((item) => item.trim()).filter(Boolean)) db.exec(statement);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
  assert.ok(tables.includes("annotation_rsi_due_checks"));
  assert.ok(tables.includes("shared_sources"));
  assert.equal(tables.some((name) => String(name).includes("review_queue")), false);
  db.close();
});
