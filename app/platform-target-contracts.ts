import {
  INFORMATION_COVER_BASELINE_ID,
  INFORMATION_COVER_PROFILE_SHA256,
} from "./information-cover-workflow.ts";

const PUBLIC_VIDEO_PREFLIGHT_CONTRACT = "contract:video-manual-preflight";

const UNKNOWN_VISIBLE_UI_LIMIT = {
  status: "unknown",
  reason: "verify_in_current_visible_editor",
  evidenceRef: PUBLIC_VIDEO_PREFLIGHT_CONTRACT,
} as const;

const UNKNOWN_ARTICLE_UI_LIMIT = {
  status: "unknown",
  reason: "article_editor_not_live_verified_in_current_contract",
  evidenceRef: "contract:article-target-manual-preflight",
} as const;

const HASH_BOUND_ARTICLE_SEMANTIC_CONTINUITY_RULE = {
  enabled: true,
  text: "平台正文适配必须通过 hash-bound 语义连续性门禁：作者入口、问题来源、首个术语解释、阅读路线、核心命题、证据边界和责任边界都要有当前正文精确引文。平台主命题必须与 canonical 使用同一摘要身份，以 lead 精确引文在前 800 字出现，并早于核心命题与边界证据；平台版同时绑定 canonical 合同、正文实算摘要与独立冷读回执。技术、格式或字数检查通过不能替代此项。",
} as const;

export const XIAOHONGSHU_VIDEO_PLATFORM_TARGET = {
  id: "target-xiaohongshu-video-manual-v4",
  supersedesIds: ["target-xiaohongshu-video-manual-v1", "target-xiaohongshu-video-manual-v2", "target-xiaohongshu-video-manual-v3"],
  profileKey: "xiaohongshu.video",
  platform: "xiaohongshu",
  label: "小红书视频",
  version: "manual-1.2.1",
  profile: {
    enabled: true,
    mediaKind: "video",
    deliveryMode: "manual",
    connectionStatus: "not_connected",
    loginEvidence: "",
    skillIds: [],
    sliceKinds: ["full", "demo", "excerpt", "promo"],
    uploadEntry: "https://creator.xiaohongshu.com/publish/publish?from=menu&target=video",
    validationScope: [
      "upload_and_platform_transcode",
      "cover_preview_and_crop",
      "title_description_topics_and_disclosures",
      "single_manual_submission",
      "platform_acceptance",
      "creator_backend_status",
      "independent_public_access_and_playback",
    ],
    evidenceRefs: [PUBLIC_VIDEO_PREFLIGHT_CONTRACT],
    constraints: {
      video: {
        maxDurationSeconds: 14_400,
        maxDurationDisplay: "4 小时",
        maxFileSizeDisplay: "20 GB",
        maxFileSizeBytes: UNKNOWN_VISIBLE_UI_LIMIT,
        recommendedContainers: ["mp4", "mov"],
        acceptedContainers: UNKNOWN_VISIBLE_UI_LIMIT,
        maxOutputResolution: UNKNOWN_VISIBLE_UI_LIMIT,
        finalAuthority: "visible_publish_page",
      },
      cover: {
        required: UNKNOWN_VISIBLE_UI_LIMIT,
        sources: ["video_frame", "uploaded_image"],
        uploadedImageExtensions: ["jpg", "jpeg", "png"],
        cropRatios: ["原始", "3:4", "4:3", "1:1"],
        sizeAdjustmentSupported: true,
      },
      title: {
        required: UNKNOWN_VISIBLE_UI_LIMIT,
        maxCharacters: 20,
        countingMode: "platform_visible_counter",
        finalAuthority: "platform_visible_counter",
      },
      description: {
        required: UNKNOWN_VISIBLE_UI_LIMIT,
        maxCharacters: 1000,
        countingMode: "platform_visible_counter",
        finalAuthority: "platform_visible_counter",
      },
      topics: { selectorVisible: true, hardLimit: UNKNOWN_VISIBLE_UI_LIMIT },
      disclosures: {
        chapterFieldVisible: true,
        collectionFieldVisible: true,
        originalDeclarationVisible: true,
        contentTypeOptions: ["虚构演绎，仅供娱乐", "笔记含AI合成内容", "内容包含营销广告", "来源声明"],
      },
      visibility: { publicOptionVisible: true, scheduledPublishingVisible: true },
      pkCover: { supported: true, autoSelectionAfterHours: 72 },
    },
    observedThisRun: {
      uploadedVideoDurationDisplay: "",
      highDefinitionPromptVisible: false,
      coverSource: "not_checked",
      coverRatio: "not_checked",
      coverSaved: false,
      coverEvaluation: "not_checked",
      pkCoverEnabled: false,
      backendStatusLanes: ["已发布", "审核中", "未通过"],
      submissionAcceptedObserved: false,
      creatorBackendEntry: "https://creator.xiaohongshu.com/new/note-manager",
      backendStatusObserved: "not_checked",
      backendStatusEvidence: "",
      remoteIdSource: "",
      candidatePublicRouteTemplate: "https://www.xiaohongshu.com/explore/{id}",
      independentPublicPlayback: {
        verified: false,
        observedAt: "",
        sessionKind: "",
        verifiedUrlKind: "",
        bareCanonicalUrlResult: "not_checked",
        durationSeconds: null,
        currentTimeRangeSeconds: [],
        readyState: null,
        mediaError: null,
      },
    },
    rules: {
      title: { enabled: true, text: "输入冻结标题后，读取当前发布页计数器；本地预检上限为 20，是否必填仍以当前页面为准。" },
      intro: { enabled: true, text: "输入冻结简介后，以发布页可见计数器核对 1000 上限；本地推测不能替代该读数。" },
      cover: { enabled: true, text: "从视频帧选择或上传 jpg/jpeg/png 后，保存并核对当前页面的实际裁切。" },
      body: { enabled: true, text: "先等视频上传与平台转码完成，再冻结封面和元数据；本地预检使用最长 4 小时、最大 20 GB 和 mp4/mov 建议，最终以当前页面为准。" },
      topics: { enabled: true, text: "发布页提供话题按钮；具体数量硬限制本次未显示，保持 unknown。" },
      disclosure: { enabled: true, text: "逐项复核章节、合集、原创声明、内容类型声明、可见范围与定时发布；按内容事实选择 AI 合成、营销、来源或虚构演绎声明，默认值不能代替核对。" },
    },
    note: "公开模板不携带历史账号、提交或播放证据。未显示的硬限制保持 unknown；每次使用都必须重新读取当前编辑器、作者后台与公开页面，且不表示发布 API 已连接。",
  },
} as const;

export const ZHIHU_VIDEO_PLATFORM_TARGET = {
  id: "target-zhihu-video-manual-v4",
  supersedesIds: ["target-zhihu-video-manual-v1", "target-zhihu-video-manual-v2", "target-zhihu-video-manual-v3"],
  profileKey: "zhihu.video",
  platform: "zhihu",
  label: "知乎视频",
  version: "manual-1.2.1",
  profile: {
    enabled: true,
    mediaKind: "video",
    deliveryMode: "manual",
    connectionStatus: "not_connected",
    loginEvidence: "",
    skillIds: [],
    sliceKinds: ["full", "demo", "excerpt", "promo"],
    uploadEntry: "https://www.zhihu.com/upload-video",
    validationScope: [
      "upload_progress_and_platform_transcode",
      "required_cover",
      "required_title_description_and_video_mark",
      "single_manual_submission",
      "platform_acceptance",
      "creator_backend_status",
      "independent_public_video_access_and_playback",
    ],
    evidenceRefs: [PUBLIC_VIDEO_PREFLIGHT_CONTRACT],
    constraints: {
      video: {
        maxDurationSeconds: 14_400,
        maxDurationDisplay: "4 小时",
        maxFileSizeDisplay: "20 GB",
        maxFileSizeBytes: UNKNOWN_VISIBLE_UI_LIMIT,
        recommendedContainers: ["mp4"],
        acceptedContainers: UNKNOWN_VISIBLE_UI_LIMIT,
        maxOutputResolution: { width: 1920, height: 1080, label: "1080P" },
        oversizedResolutionBehavior: "transcode_to_1080p",
        uploadCompletionRequiredBeforeEditing: true,
        finalAuthority: "visible_upload_page",
      },
      cover: { required: true, acceptedExtensions: UNKNOWN_VISIBLE_UI_LIMIT, cropRatios: UNKNOWN_VISIBLE_UI_LIMIT },
      title: { required: true, maxCharacters: UNKNOWN_VISIBLE_UI_LIMIT },
      description: { required: true, maxCharacters: UNKNOWN_VISIBLE_UI_LIMIT },
      topics: { selectorVisible: UNKNOWN_VISIBLE_UI_LIMIT, hardLimit: UNKNOWN_VISIBLE_UI_LIMIT },
      disclosures: {
        videoMarkRequired: true,
        videoMarkOptions: UNKNOWN_VISIBLE_UI_LIMIT,
        originalVideoDefaultChecked: true,
        sourceFieldVisible: true,
      },
      distribution: {
        domainFieldVisible: true,
        columnFieldVisible: true,
        publishToColumnDefault: false,
        scheduledPublishingVisible: true,
        commentPermissionVisible: true,
        syncCircleVisible: true,
      },
    },
    observedThisRun: {
      uploadProgressRange: [0, 100],
      uploadedFileSizeDisplay: "",
      uploadCompletedBeforeMetadata: false,
      originalVideoDefaultChecked: true,
      publishToColumnDefault: false,
      submissionAcceptedObserved: false,
      creatorBackendEntry: "https://www.zhihu.com/creator/manage/creation/zvideo",
      backendStatusObserved: "not_checked",
      backendStatusEvidence: "",
      publicRouteKinds: ["pin", "zvideo"],
      publicRouteKindObservedThisRun: "not_checked",
      independentPublicPlayback: {
        verified: false,
        observedAt: "",
        sessionKind: "",
        durationSeconds: null,
        currentTimeRangeSeconds: [],
        readyState: null,
        mediaError: null,
      },
    },
    rules: {
      title: { enabled: true, text: "标题为必填；公开模板不固化字数上限，maxCharacters 保持 unknown。" },
      intro: { enabled: true, text: "介绍为必填；公开模板不固化字数上限，maxCharacters 保持 unknown。" },
      cover: { enabled: true, text: "封面为必填；必须在上传成功后看到并核对封面预览，格式、尺寸与裁切比例以当前页面为准。" },
      body: { enabled: true, text: "先等待上传进度达到 100 且平台处理成功；本地预检使用最长 4 小时、最大 20 GB、最高 1080P 和 mp4 建议，最终以当前页面为准。" },
      topics: { enabled: false, text: "公开模板不声明话题字段或数量硬限制，不把所属领域、专栏或圈子冒充话题。" },
      disclosure: { enabled: true, text: "视频标记为必填；同时复核原创视频、所属领域、专栏、定时、来源、评论权限与同步圈子。默认勾选不等于已经按内容事实确认。" },
    },
    note: "公开模板不携带历史账号、提交或播放证据。标题、介绍、封面格式等未固定的硬限制保持 unknown；每次使用都必须重新读取当前编辑器、作者后台与公开页面，且不表示发布 API 已连接。",
  },
} as const;

export const VIDEO_PLATFORM_TARGETS = [
  XIAOHONGSHU_VIDEO_PLATFORM_TARGET,
  ZHIHU_VIDEO_PLATFORM_TARGET,
] as const;

/**
 * 小红书长文的人工发布画像。
 *
 * 约束来自当前 publish-xiaohongshu-long-article Skill；任何计数仍以本次
 * 可见编辑器为最终依据。该画像只声明人工网页流程，不声明 API 已连接。
 */
export const XIAOHONGSHU_ARTICLE_PLATFORM_TARGET = {
  id: "target-xiaohongshu-manual-v2",
  supersedesIds: ["target-xiaohongshu-manual-v1"],
  profileKey: "xiaohongshu.article",
  platform: "xiaohongshu",
  label: "小红书长文",
  version: "manual-1.1.0",
  profile: {
    enabled: true,
    mediaKind: "article",
    deliveryMode: "manual",
    connectionStatus: "not_connected",
    loginEvidence: "",
    skillIds: ["publish-xiaohongshu-long-article"],
    sliceKinds: ["full", "demo", "excerpt", "promo"],
    uploadEntry: "https://creator.xiaohongshu.com",
    validationScope: [
      "frozen_docx_and_hash_bound_information_cover",
      "visible_docx_import_and_content_fidelity",
      "hash_bound_platform_semantic_continuity_gate",
      "large_image_template_and_custom_cover_preview",
      "heading_highlight_and_list_hierarchy",
      "platform_title_body_topics_and_ai_disclosure",
      "single_manual_submission",
      "creator_backend_status",
      "independent_public_article_access",
    ],
    evidenceRefs: [
      "skill:publish-xiaohongshu-long-article",
      "skill:design-information-article-cover",
    ],
    constraints: {
      import: {
        required: true,
        acceptedExtensions: ["docx"],
        visibleFileImportOnly: true,
      },
      template: {
        requiredForThisWorkflow: "大图纯享",
        finalAuthority: "visible_preview",
      },
      cover: {
        required: true,
        informationCoverBaselineId: INFORMATION_COVER_BASELINE_ID,
        informationCoverProfileSha256: INFORMATION_COVER_PROFILE_SHA256,
        currentHashBoundCopyLayoutRenderAndHumanQaRequired: true,
        platformCropAndOverlayMustBeRechecked: true,
        finalAuthority: "visible_preview",
      },
      title: {
        required: true,
        maxCharacters: 20,
        countingMode: "platform_visible_counter",
        finalAuthority: "platform_visible_counter",
      },
      body: {
        required: true,
        maxCharacters: 1000,
        includesTopics: true,
        countingMode: "platform_visible_counter",
        finalAuthority: "platform_visible_counter",
      },
      topics: {
        maxCount: 10,
        selectionMode: "type_hash_then_select_visible_suggestion",
        pastedHashTextDoesNotProveFormalTopic: true,
      },
      disclosures: {
        aiContentDeclarationRequiredWhenApplicable: true,
        unauthorizedActivityAssociationMustBeRemoved: true,
      },
    },
    rules: {
      semanticContinuity: HASH_BOUND_ARTICLE_SEMANTIC_CONTINUITY_RULE,
      import: {
        enabled: true,
        text: "输入唯一 DOCX 后，只通过可见文件选择器导入；输出前核对正文首尾、H2 和实际内容齐全，上传动画结束不能代替内容读回。",
      },
      cover: {
        enabled: true,
        text: "必须使用当前 information-knowledge-cover-v2 且 copy/layout/render/人工 QA 全部绑定同一 PNG SHA-256；平台裁切、标题叠层和渐变仍须在当前预览复核。",
      },
      body: {
        enabled: true,
        text: "恢复真实 H2、少量高亮和列表层级；正文第一张重复封面必须在一键排版前删除。",
      },
      topics: {
        enabled: true,
        text: "话题最多 10 个；逐个输入 #、等待并选择可见候选，粘贴的纯文本井号不能冒充正式话题。",
      },
      disclosure: {
        enabled: true,
        text: "内容含 AI 生成或辅助合成时选择对应声明；自动关联活动未经用户授权必须取消。",
      },
      publicationEvidence: {
        enabled: true,
        text: "依次分层记录 artifact_validated、platform_applied、submitted、backend_published 与 published_publicly_verified；前一层证据不能推出后一层。",
      },
    },
    note: "该画像来自当前本地发布 Skill 的可见 Chrome 人工流程合同，不表示登录仍有效、平台 API 已连接或未来界面限制不会变化；发布前必须以当前页面计数器、预览、后台记录与独立公开页重新验收。",
  },
} as const;

/**
 * Bilibili 图文/专栏的人工发布画像。
 *
 * 这不是 API 连接声明；它只冻结可见编辑器中已经复核过的字段和
 * 读者体验约束。尤其是正文 tag 与“添加话题”是两项不同的输入：
 * tag 必须置于参考资料与口径说明之后，不能占用标题前的首屏。
 */
export const BILIBILI_ARTICLE_PLATFORM_TARGET = {
  id: "target-bilibili-manual-v2",
  supersedesIds: ["target-bilibili-manual-v1"],
  profileKey: "bilibili.article",
  platform: "bilibili",
  label: "Bilibili 专栏",
  version: "manual-1.1.0",
  profile: {
    enabled: true,
    mediaKind: "article",
    deliveryMode: "manual",
    connectionStatus: "not_connected",
    loginEvidence: "",
    skillIds: ["publish-bilibili-article"],
    sliceKinds: ["full", "demo", "excerpt", "promo"],
    uploadEntry: "https://member.bilibili.com/platform/upload/text/new-edit",
    validationScope: [
      "frozen_docx_or_markdown_import",
      "lead_middle_and_tail_content_fidelity",
      "hash_bound_platform_semantic_continuity_gate",
      "bottom_only_inline_tags",
      "separate_platform_topic_selection",
      "public_visibility_and_creation_disclosures",
      "single_manual_submission",
      "creator_backend_status",
      "independent_public_article_access",
    ],
    evidenceRefs: ["run:2026-08-21:bilibili-article-manual-submit"],
    constraints: {
      import: {
        acceptedExtensions: ["docx", "md"],
        maxFileSizeBytes: 15 * 1024 * 1024,
        overwriteWarning: true,
      },
      title: {
        suggestion: "建议30字以内",
        hardLimit: UNKNOWN_VISIBLE_UI_LIMIT,
        finalAuthority: "visible_editor",
      },
      body: {
        maxCharacters: 100_000,
        finalAuthority: "visible_editor_counter",
      },
      inlineTags: {
        supported: true,
        placement: "document_tail_after_references_and_disclosures",
        forbiddenPlacement: "before_title_or_lead",
        mustBeVisuallyVerifiedBeforeSubmission: true,
      },
      topics: {
        selectorVisible: true,
        separateFromInlineTags: true,
        finalAuthority: "visible_editor",
      },
      disclosures: {
        originalDeclarationVisible: true,
        aiAssistedCreationVisible: true,
        requiredForThisWorkflow: ["original_declaration", "ai_assisted_creation"],
      },
      visibility: {
        publicOptionVisible: true,
      },
      cover: {
        customCoverOptional: true,
        unsetBehavior: "platform_uses_opening_body_content",
        informationCoverBaselineIdWhenCustomCoverUsed: INFORMATION_COVER_BASELINE_ID,
        informationCoverProfileSha256WhenCustomCoverUsed: INFORMATION_COVER_PROFILE_SHA256,
        currentHashBoundQaRequiredWhenCustomCoverUsed: true,
        finalAuthority: "visible_preview",
      },
    },
    rules: {
      semanticContinuity: HASH_BOUND_ARTICLE_SEMANTIC_CONTINUITY_RULE,
      body: {
        enabled: true,
        text: "导入后依次核对开头、中段、结尾和正文计数器；上传结束或自动保存不能代替内容完整性读回。",
      },
      inlineTags: {
        enabled: true,
        text: "允许正文 #tag#，但必须在参考资料和任何口径说明之后；若导入或编辑器把 tag 放到标题前/导语前，提交前移到文末。平台“添加话题”与正文 tag 分开设置。",
      },
      disclosure: {
        enabled: true,
        text: "发布前按内容事实同时复核原创声明与 AI 辅助创作声明；两者都被选择不等于后台已通过或公开页已可访问。",
      },
      publicationEvidence: {
        enabled: true,
        text: "“专栏已提交成功”只推进到 submitted；后台精确记录和独立公开页仍须分别核验。",
      },
    },
    note: "该画像来自 2026-08-21 可见 Bilibili 专栏编辑器的 DOCX 导入与单篇提交现场。它不表示账号、发布 API 或数据接口已经连接；提交成功、后台状态和公开可访问必须分层登记。",
  },
} as const;

/**
 * 知乎文章的人工发布画像。
 *
 * 当前仓库没有已实跑并归属明确的知乎文章发布 Skill，因此平台字段上限保持
 * unknown；本地不可变正文、封面和分层发布证据仍作为硬合同。
 */
export const ZHIHU_ARTICLE_PLATFORM_TARGET = {
  id: "target-zhihu-manual-v2",
  supersedesIds: ["target-zhihu-manual-v1"],
  profileKey: "zhihu.article",
  platform: "zhihu",
  label: "知乎文章",
  version: "manual-1.1.0",
  profile: {
    enabled: true,
    mediaKind: "article",
    deliveryMode: "manual",
    connectionStatus: "not_connected",
    loginEvidence: "",
    skillIds: [],
    sliceKinds: ["full", "demo", "excerpt", "promo"],
    uploadEntry: "https://www.zhihu.com/creator",
    validationScope: [
      "frozen_article_artifact_and_current_information_cover",
      "visible_manual_import_or_paste",
      "hash_bound_platform_semantic_continuity_gate",
      "lead_middle_tail_and_heading_fidelity",
      "current_editor_constraints_and_disclosures",
      "single_manual_submission",
      "creator_backend_status",
      "independent_public_article_access",
    ],
    evidenceRefs: [
      "contract:article-target-manual-preflight",
      "skill:design-information-article-cover",
    ],
    constraints: {
      import: {
        mode: "visible_manual_import_or_paste",
        acceptedExtensions: UNKNOWN_ARTICLE_UI_LIMIT,
        finalAuthority: "visible_editor",
      },
      title: {
        required: UNKNOWN_ARTICLE_UI_LIMIT,
        maxCharacters: UNKNOWN_ARTICLE_UI_LIMIT,
        finalAuthority: "visible_editor_counter",
      },
      body: {
        required: true,
        maxCharacters: UNKNOWN_ARTICLE_UI_LIMIT,
        finalAuthority: "visible_editor_counter",
      },
      summary: {
        required: UNKNOWN_ARTICLE_UI_LIMIT,
        maxCharacters: UNKNOWN_ARTICLE_UI_LIMIT,
        finalAuthority: "visible_editor",
      },
      cover: {
        platformRequired: UNKNOWN_ARTICLE_UI_LIMIT,
        informationCoverBaselineIdWhenUsed: INFORMATION_COVER_BASELINE_ID,
        informationCoverProfileSha256WhenUsed: INFORMATION_COVER_PROFILE_SHA256,
        currentHashBoundCopyLayoutRenderAndHumanQaRequiredWhenUsed: true,
        finalAuthority: "visible_preview",
      },
      topics: {
        selectorVisible: UNKNOWN_ARTICLE_UI_LIMIT,
        hardLimit: UNKNOWN_ARTICLE_UI_LIMIT,
        finalAuthority: "visible_editor",
      },
      disclosures: {
        aiAssistedContentControl: UNKNOWN_ARTICLE_UI_LIMIT,
        originalDeclarationControl: UNKNOWN_ARTICLE_UI_LIMIT,
        finalAuthority: "visible_editor",
      },
    },
    rules: {
      semanticContinuity: HASH_BOUND_ARTICLE_SEMANTIC_CONTINUITY_RULE,
      import: {
        enabled: true,
        text: "仅在可见编辑器内人工导入或粘贴冻结版本；开头、中段、结尾与标题层级均核对后才能签发 Fidelity。",
      },
      cover: {
        enabled: true,
        text: "使用信息型封面时只接受当前 information-knowledge-cover-v2 与同一 PNG SHA-256 的完整本地 QA；平台是否要求封面及其裁切限制以当次可见预览为准。",
      },
      constraints: {
        enabled: true,
        text: "标题、摘要、话题、封面和声明的当前硬限制尚未由知乎文章编辑器实跑冻结，全部失败关闭为 unknown，不用视频画像或历史经验代填。",
      },
      publicationEvidence: {
        enabled: true,
        text: "分别读取提交提示、创作者后台记录与独立公开文章页；任一较低层证据不能自动推出较高层 Claim。",
      },
    },
    note: "该画像把知乎文章从无规则 generic 目标升级为显式 manual/unknown 合同，但没有新增平台事实声明，也不表示登录、发布 API、标题/摘要/话题/封面限制或公开访问已核验；首次真实发布必须回读当前编辑器并按证据更新专属 Skill/Target。",
  },
} as const;

export const ARTICLE_PLATFORM_TARGETS = [
  XIAOHONGSHU_ARTICLE_PLATFORM_TARGET,
  BILIBILI_ARTICLE_PLATFORM_TARGET,
  ZHIHU_ARTICLE_PLATFORM_TARGET,
] as const;

export const MAIMAI_PLATFORM_TARGET = {
  id: "target-maimai-manual-v1",
  profileKey: "maimai.community-post",
  platform: "maimai",
  label: "脉脉动态",
  version: "manual-1.0.0",
  profile: {
    enabled: true,
    deliveryMode: "manual",
    connectionStatus: "not_connected",
    loginEvidence: "",
    skillIds: [],
    sliceKinds: ["full", "demo", "excerpt", "promo"],
    validationScope: [
      "manual_import_or_upload",
      "normal_reading_and_rendering",
      "content_fidelity",
      "hash_bound_platform_semantic_continuity_gate",
      "maimai_visible_counter_and_settings",
    ],
    evidenceRefs: ["contract:maimai-manual-preflight"],
    constraints: {
      title: {
        required: false,
        maxCharacters: 20,
        countingMode: "utf16_code_units_local_preflight",
        finalAuthority: "platform_visible_counter",
        evidenceRef: "contract:maimai-visible-counter",
      },
      body: {
        maxCharacters: 1000,
        countingMode: "utf16_code_units_local_preflight",
        finalAuthority: "platform_visible_counter",
        includesInlineTopics: true,
      },
      images: {
        maxCount: 9,
        placement: "bottom_attachments_only",
        inlineSupported: false,
      },
      topics: {
        placement: "inline_body",
      },
      aiAssistance: {
        required: true,
        selectionLabel: "含AI辅助创作",
      },
    },
    rules: {
      semanticContinuity: HASH_BOUND_ARTICLE_SEMANTIC_CONTINUITY_RULE,
      title: {
        enabled: true,
        text: "标题为可选字段，最多 20 字符；本地预检按 UTF-16 code unit 计数，发布页可见的 0/20 计数器是最终依据。",
      },
      intro: {
        enabled: false,
        text: "脉脉动态不建立独立简介适配；导语属于正文并计入正文额度。",
      },
      cover: {
        enabled: true,
        text: "最多附加 9 张图片；图片统一展示在正文底部，不支持正文内插图，也不把附件图冒充文章内图文排版。",
      },
      body: {
        enabled: true,
        text: "正文连同直接写入正文的话题 tag，必须通过发布页可见的 0/1000 计数器；本地预检按 UTF-16 code unit 保守计数，平台计数器是最终依据。",
      },
      topics: {
        enabled: true,
        text: "tag 直接写进正文，不依赖独立话题字段；所有 tag 一并计入 1000 字额度。",
      },
      disclosure: {
        enabled: true,
        text: "核对发布设置已勾选“含AI辅助创作”；未勾选时不得把 Release 写成已获批准提交。",
      },
    },
    note: "该画像只描述脉脉社区动态的人工适配与验收合同，不表示账号、发布 API 或数据接口已经连接。",
  },
} as const;

export type MaimaiDraft = {
  titleText?: string;
  bodyText: string;
  imageCount: number;
  imagePlacement: "bottom_attachments_only" | "bottom_attachments" | "bottom_gallery_only" | "inline" | "none";
  aiAssistedCreationSelected: boolean;
  topicTags: string[];
};

export type MaimaiViolationCode =
  | "title_over_limit"
  | "body_over_limit"
  | "too_many_images"
  | "images_must_be_bottom_attachments"
  | "ai_disclosure_required"
  | "tags_must_be_inline_body";

export type MaimaiPreflightResult = {
  ok: boolean;
  titleCharacterCount: number;
  bodyCharacterCount: number;
  imageCount: number;
  canonicalImagePlacement: "bottom_attachments_only" | "inline" | "none" | null;
  violations: Array<{ code: MaimaiViolationCode; message: string }>;
};

function canonicalMaimaiImagePlacement(value: MaimaiDraft["imagePlacement"]): MaimaiPreflightResult["canonicalImagePlacement"] {
  if (value === "bottom_attachments_only" || value === "bottom_attachments" || value === "bottom_gallery_only") {
    return "bottom_attachments_only";
  }
  if (value === "inline" || value === "none") return value;
  return null;
}

export function validateMaimaiDraft(draft: MaimaiDraft): MaimaiPreflightResult {
  const violations: MaimaiPreflightResult["violations"] = [];
  const titleCharacterCount = (draft.titleText ?? "").length;
  const bodyCharacterCount = draft.bodyText.length;
  const canonicalImagePlacement = canonicalMaimaiImagePlacement(draft.imagePlacement);
  if (titleCharacterCount > MAIMAI_PLATFORM_TARGET.profile.constraints.title.maxCharacters) {
    violations.push({ code: "title_over_limit", message: "可选标题不能超过 20 字。" });
  }
  if (bodyCharacterCount > MAIMAI_PLATFORM_TARGET.profile.constraints.body.maxCharacters) {
    violations.push({ code: "body_over_limit", message: "正文与正文内 tag 合计不能超过 1000 字。" });
  }
  if (!Number.isInteger(draft.imageCount) || draft.imageCount < 0 || draft.imageCount > MAIMAI_PLATFORM_TARGET.profile.constraints.images.maxCount) {
    violations.push({ code: "too_many_images", message: "图片数量必须在 0 到 9 张之间。" });
  }
  if (draft.imageCount > 0 && canonicalImagePlacement !== "bottom_attachments_only") {
    violations.push({ code: "images_must_be_bottom_attachments", message: "图片只能作为正文底部附件，不能插入正文。" });
  }
  if (!draft.aiAssistedCreationSelected) {
    violations.push({ code: "ai_disclosure_required", message: "发布设置必须勾选“含AI辅助创作”。" });
  }
  const missingInlineTags = [...new Set(draft.topicTags.map((tag) => tag.trim()).filter(Boolean))]
    .filter((tag) => !draft.bodyText.includes(tag));
  if (missingInlineTags.length > 0) {
    violations.push({ code: "tags_must_be_inline_body", message: `这些 tag 尚未直接写入正文：${missingInlineTags.join("、")}` });
  }
  return {
    ok: violations.length === 0,
    titleCharacterCount,
    bodyCharacterCount,
    imageCount: draft.imageCount,
    canonicalImagePlacement,
    violations,
  };
}
