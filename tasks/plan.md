# PDF 外网溯源严格核验链路实施状态

原两阶段实现计划已经被严格隔离式链路取代，当前权威规格见：

- `docs/spec-qwen-ai-pipeline.md`
- `docs/superpowers/specs/2026-07-17-strict-external-pdf-audit-design.md`
- `docs/superpowers/plans/2026-07-17-strict-external-pdf-audit.md`

当前链路依次执行 layout、evidence、URL 双图复核、table、ID-only association 和确定性 finalize。原始 PDF 不上传；最终汇总不调用模型。发布前必须完成单元测试、源码验收、类型检查、lint、生产构建、依赖审计和密钥扫描。
