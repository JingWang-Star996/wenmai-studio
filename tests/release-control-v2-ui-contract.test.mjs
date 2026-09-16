import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const panel = await readFile(new URL("../app/ReleaseControlV2Panel.tsx", import.meta.url), "utf8");
const hub = await readFile(new URL("../app/DistributionHub.tsx", import.meta.url), "utf8");

test("发布授权 UI 只访问固定 v2 API 并经管理会话请求", () => {
  assert.match(panel, /import \{ managementFetch \} from "\.\/management-fetch"/);
  assert.match(panel, /\/api\/release-control\/v2\?articleId=/);
  assert.match(panel, /managementFetch\("\/api\/release-control\/v2"/);
  assert.match(panel, /readiness\.record/);
  assert.match(panel, /confirmation\.create/);
  assert.doesNotMatch(panel, /capability\.consume|capability\.sign|click\s*\(/i);
});

test("发布授权只允许严格四平台的未过期准备快照进入确认", () => {
  assert.match(panel, /ready\.length !== 4/);
  assert.match(panel, /REQUIRED_PLATFORMS\.every/);
  assert.match(panel, /snapshot\.state === "ready_to_submit" && !expired\(snapshot\)/);
  assert.match(panel, /readinessSnapshotIds: confirmable\.map\(idOf\)/);
  assert.match(panel, /contractSha256: CONTRACT_SHA256/);
});

test("准备证据以服务端 releaseCandidates 为主源，零快照候选仍可受限填写", () => {
  assert.match(panel, /releaseCandidates\?: Item\[\]/);
  assert.match(panel, /const releases = useMemo\(\(\) => list\(data\?\.releaseCandidates\)/);
  assert.match(panel, /const eligible = release\.eligible === true/);
  assert.match(panel, /const blockers = Array\.isArray\(release\.blockers\)/);
  assert.match(panel, /disabled=\{!eligible \|\| savingReleaseId === releaseId\}/);
});

test("界面包含锁定、外部结果边界和 Hub 发布授权标签", () => {
  assert.match(panel, /本机发布宿主尚未验收，最终点击仍被锁定/);
  assert.match(panel, /确认或 capability_consumed 都不等于 submission_accepted/);
  assert.match(panel, /记录本地准备证据/);
  assert.match(panel, /确认本篇四个平台的一次性发布授权/);
  assert.match(hub, /ReleaseControlV2Panel/);
  assert.match(hub, /setPanel\("authorization"\).*发布授权/);
});
