import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const migration27 = await readFile(new URL("../drizzle/0027_release_control_v2.sql", import.meta.url), "utf8");
const migration28 = await readFile(new URL("../drizzle/0028_release_control_v2_dom_binding.sql", import.meta.url), "utf8");
const hash = "a".repeat(64);

function execMigration(db, sql) {
  db.exec(sql.replaceAll("--> statement-breakpoint", ""));
}

function legacy0027() {
  const tableStart = migration27.indexOf("CREATE TABLE `release_publish_capabilities_v2`");
  return migration27.slice(0, tableStart) + migration27.slice(tableStart)
    .replace(/\t`dom_contract_sha256` text NOT NULL,\r?\n/, "")
    .replace(/,\r?\n\tCONSTRAINT "release_publish_capabilities_v2_dom_contract_sha256_check" CHECK\(length\("release_publish_capabilities_v2"\."dom_contract_sha256"\) = 64 AND "release_publish_capabilities_v2"\."dom_contract_sha256" NOT GLOB '\*\[\^0-9A-Fa-f\]\*'\)/, "");
}

function insertLegacyCapability(db, domContractSha256) {
  const packet = JSON.stringify({ domContractSha256 });
  db.prepare(`INSERT INTO release_publish_capabilities_v2 (
    id, confirmation_id, article_id, run_id, build_id, release_id, platform,
    execution_packet_json, packet_json_sha256, packet_sha256, artifact_sha256,
    readiness_snapshot_sha256, target_account, nonce_sha256, max_clicks, status,
    issued_at, expires_at, consumed_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'issued', ?, ?, NULL)`).run(
    "cap-1", "confirmation-1", "article-1", "run-1", "build-1", "release-1", "bilibili",
    packet, "b".repeat(64), "c".repeat(64), "d".repeat(64), "e".repeat(64), "account-1", "f".repeat(64),
    "2026-09-02T00:00:00.000Z", "2026-09-02T00:05:00.000Z",
  );
}

test("0027 provisions the bound column and 0028 remains safe on an empty new database", () => {
  const db = new DatabaseSync(":memory:");
  execMigration(db, migration27);
  execMigration(db, migration28);
  assert.equal(db.prepare("SELECT count(*) AS total FROM release_publish_capabilities_v2").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) AS total FROM pragma_table_info('release_publish_capabilities_v2') WHERE name = 'dom_contract_sha256' AND \"notnull\" = 1").get().total, 1);
});

test("0028 backfills a legacy 0027 capability from its execution packet", () => {
  const db = new DatabaseSync(":memory:");
  execMigration(db, legacy0027());
  insertLegacyCapability(db, hash);
  execMigration(db, migration28);
  const row = db.prepare("SELECT id, dom_contract_sha256 FROM release_publish_capabilities_v2").get();
  assert.equal(row.id, "cap-1");
  assert.equal(row.dom_contract_sha256, hash);
});

test("0028 fails closed and can retry when a legacy packet has no valid DOM-contract SHA-256", () => {
  for (const domContractSha256 of ["g".repeat(64), undefined]) {
    const db = new DatabaseSync(":memory:");
    execMigration(db, legacy0027());
    insertLegacyCapability(db, domContractSha256);
    assert.throws(() => execMigration(db, migration28));

    // The INSERT into the staging table fails before the canonical table is
    // dropped. D1 applies migrations atomically; this direct-SQL regression
    // test additionally proves the safe ordering without SQL BEGIN/COMMIT.
    assert.equal(db.prepare("SELECT count(*) AS total FROM release_publish_capabilities_v2").get().total, 1);
    assert.equal(db.prepare("SELECT count(*) AS total FROM pragma_table_info('release_publish_capabilities_v2') WHERE name = 'dom_contract_sha256'").get().total, 0);

    // A retry starts by discarding only the disposable staging table, then
    // succeeds once the source packet is made valid.
    db.prepare("UPDATE release_publish_capabilities_v2 SET execution_packet_json = ? WHERE id = 'cap-1'")
      .run(JSON.stringify({ domContractSha256: hash }));
    execMigration(db, migration28);
    assert.equal(db.prepare("SELECT dom_contract_sha256 FROM release_publish_capabilities_v2 WHERE id = 'cap-1'").get().dom_contract_sha256, hash);
  }
});
