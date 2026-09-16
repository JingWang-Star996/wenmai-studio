# Local data boundary / 本地数据边界

This directory contains safe examples for a clean public clone, including one explicitly synthetic demonstration article. `npm run data:bootstrap` copies the examples to ignored `*.generated.json` files only when those files do not already exist.

Your indexed articles, text blobs, capability inventory, validation reports, databases, credentials, and runtime evidence stay local and are ignored by Git. The bootstrap command never replaces an existing generated file.

Use the bounded local import or Agent access workflow in the project documentation to add your own articles. The private corpus snapshot validator, its immutable baseline, and its regression fixtures are intentionally not distributed. Review generated files before moving or sharing a working directory.

本目录只保存可公开示例，其中只有一篇明确标注的合成演示文章。`npm run data:bootstrap` 仅在目标不存在时生成被 Git 忽略的 `*.generated.json`，不会覆盖现有索引。真实文章、正文、能力盘点、数据库、凭据和运行证据均留在本机；请按项目教程通过受限本地导入或 Agent 接口加入自己的文章。私有语料快照校验器、不可变基线和回归 fixture 不随公开版本分发；移动或分享工作目录前，请自行复核生成文件。
