import assert from "node:assert/strict";
import test from "node:test";

import {
  ARTICLE_PLATFORM_TARGETS,
  BILIBILI_ARTICLE_PLATFORM_TARGET,
  XIAOHONGSHU_ARTICLE_PLATFORM_TARGET,
  ZHIHU_ARTICLE_PLATFORM_TARGET,
} from "../app/platform-target-contracts.ts";
import {
  INFORMATION_COVER_BASELINE_ID,
  INFORMATION_COVER_PROFILE_SHA256,
} from "../app/information-cover-workflow.ts";

test("文章平台注册表导出小红书、Bilibili 与知乎三个一等 Target", () => {
  assert.deepEqual(
    ARTICLE_PLATFORM_TARGETS.map((target) => target.profileKey),
    ["xiaohongshu.article", "bilibili.article", "zhihu.article"],
  );
  for (const target of ARTICLE_PLATFORM_TARGETS) {
    assert.equal(target.profile.mediaKind, "article");
    assert.equal(target.profile.deliveryMode, "manual");
    assert.equal(target.profile.connectionStatus, "not_connected");
    assert.equal(target.profile.enabled, true);
  }
});

test("小红书长文 Target 绑定当前封面基线、发布 Skill 与可见计数器", () => {
  const target = XIAOHONGSHU_ARTICLE_PLATFORM_TARGET;
  assert.equal(target.id, "target-xiaohongshu-manual-v2");
  assert.deepEqual(target.supersedesIds, ["target-xiaohongshu-manual-v1"]);
  assert.equal(target.version, "manual-1.1.0");
  assert.deepEqual(target.profile.skillIds, ["publish-xiaohongshu-long-article"]);
  assert.deepEqual(target.profile.constraints.import.acceptedExtensions, ["docx"]);
  assert.equal(target.profile.constraints.template.requiredForThisWorkflow, "大图纯享");
  assert.equal(target.profile.constraints.cover.informationCoverBaselineId, INFORMATION_COVER_BASELINE_ID);
  assert.equal(target.profile.constraints.cover.informationCoverProfileSha256, INFORMATION_COVER_PROFILE_SHA256);
  assert.equal(target.profile.constraints.title.maxCharacters, 20);
  assert.equal(target.profile.constraints.body.maxCharacters, 1000);
  assert.equal(target.profile.constraints.body.includesTopics, true);
  assert.equal(target.profile.constraints.topics.maxCount, 10);
  assert.match(target.profile.rules.publicationEvidence.text, /分层记录/);
});

test("知乎文章 Target 对未实跑字段保持 unknown，同时绑定本地封面当前性", () => {
  const target = ZHIHU_ARTICLE_PLATFORM_TARGET;
  assert.equal(target.id, "target-zhihu-manual-v2");
  assert.deepEqual(target.supersedesIds, ["target-zhihu-manual-v1"]);
  assert.equal(target.version, "manual-1.1.0");
  assert.deepEqual(target.profile.skillIds, []);
  assert.equal(target.profile.constraints.title.maxCharacters.status, "unknown");
  assert.equal(target.profile.constraints.summary.required.status, "unknown");
  assert.equal(target.profile.constraints.topics.hardLimit.status, "unknown");
  assert.equal(target.profile.constraints.cover.informationCoverBaselineIdWhenUsed, INFORMATION_COVER_BASELINE_ID);
  assert.equal(target.profile.constraints.cover.informationCoverProfileSha256WhenUsed, INFORMATION_COVER_PROFILE_SHA256);
  assert.match(target.profile.note, /没有新增平台事实声明/);
});

test("Bilibili 自定义知识封面也使用同一 canonical baseline", () => {
  const cover = BILIBILI_ARTICLE_PLATFORM_TARGET.profile.constraints.cover;
  assert.equal(cover.informationCoverBaselineIdWhenCustomCoverUsed, INFORMATION_COVER_BASELINE_ID);
  assert.equal(cover.informationCoverProfileSha256WhenCustomCoverUsed, INFORMATION_COVER_PROFILE_SHA256);
  assert.equal(cover.currentHashBoundQaRequiredWhenCustomCoverUsed, true);
});
