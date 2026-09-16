import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { BILIBILI_ARTICLE_PLATFORM_TARGET } from "../app/platform-target-contracts.ts";

const lifecycleRoute = readFileSync(new URL("../app/api/lifecycle/route.ts", import.meta.url), "utf8");

test("Bilibili 专栏使用版本化人工画像，不再退回无规则的通用目标", () => {
  assert.equal(BILIBILI_ARTICLE_PLATFORM_TARGET.id, "target-bilibili-manual-v2");
  assert.equal(BILIBILI_ARTICLE_PLATFORM_TARGET.profileKey, "bilibili.article");
  assert.deepEqual(BILIBILI_ARTICLE_PLATFORM_TARGET.supersedesIds, ["target-bilibili-manual-v1"]);
  assert.equal(BILIBILI_ARTICLE_PLATFORM_TARGET.profile.deliveryMode, "manual");
  assert.equal(BILIBILI_ARTICLE_PLATFORM_TARGET.profile.connectionStatus, "not_connected");
  assert.match(lifecycleRoute, /\bARTICLE_PLATFORM_TARGETS\b/);
  assert.match(lifecycleRoute, /\.\.\.ARTICLE_PLATFORM_TARGETS/);
});

test("正文标签与平台话题分开，标签必须在文章尾部验收", () => {
  const profile = BILIBILI_ARTICLE_PLATFORM_TARGET.profile;
  assert.equal(profile.constraints.import.maxFileSizeBytes, 15 * 1024 * 1024);
  assert.deepEqual(profile.constraints.import.acceptedExtensions, ["docx", "md"]);
  assert.equal(profile.constraints.inlineTags.placement, "document_tail_after_references_and_disclosures");
  assert.equal(profile.constraints.inlineTags.forbiddenPlacement, "before_title_or_lead");
  assert.equal(profile.constraints.inlineTags.mustBeVisuallyVerifiedBeforeSubmission, true);
  assert.equal(profile.constraints.topics.separateFromInlineTags, true);
  assert.match(profile.rules.inlineTags.text, /标题前/);
});

test("原创与 AI 声明以及三层发布证据均被保留", () => {
  const profile = BILIBILI_ARTICLE_PLATFORM_TARGET.profile;
  assert.deepEqual(profile.constraints.disclosures.requiredForThisWorkflow, ["original_declaration", "ai_assisted_creation"]);
  assert.equal(profile.constraints.visibility.publicOptionVisible, true);
  assert.match(profile.rules.publicationEvidence.text, /submitted/);
  assert.match(profile.note, /后台状态和公开可访问必须分层登记/);
});
