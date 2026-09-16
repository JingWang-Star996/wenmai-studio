# Public release export contract v1

本地八次提交历史包含旧拓扑，不能直接 push。未来公开导出必须由显式清单经 `scripts/stage-public-release-candidate.py` 生成仓库外、此前不存在的隔离候选；随后在新仓库创建单一 `sanitized initial public import`。原仓库不 reset、不 rewrite。

候选只复制清单中逐字节复核过的普通文件，并扫描常见凭据模式和调用方提供的禁用字面量。通过只表示本地 stage 候选有效；不表示 Git commit/history、无秘密、行为、浏览器、DB、GitHub 或公开可见。历史 raw QA 只留在本地，不进入 public candidate。
