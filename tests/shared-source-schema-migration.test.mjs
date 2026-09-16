import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
test("只保留 0031 基础来源迁移", () => {
  const migration = fs.readdirSync(new URL("../drizzle/", import.meta.url)).find((name) => /^0031.*\.sql$/u.test(name));
  assert.ok(migration);
  const sql = fs.readFileSync(new URL(`../drizzle/${migration}`, import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE `shared_sources`/); assert.match(sql, /shared_source_versions/); assert.equal(fs.existsSync(new URL("../drizzle/0032_shared_source_containers.sql", import.meta.url)), false);
});
