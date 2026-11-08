# 🐟 鱼板记忆

鱼板记忆（`dsh-fishboard-memory`）是一个面向 DSH 的长期记忆插件。它把真实聊天逐层整理为原始归档、事件卡和长期事实，再根据当前话题进行受控召回，减少上下文压缩后的人格与关系断裂。

> 这是基于 MIT 项目 `dsh-fish-memory` 的独立维护分支，由 `hang27068` 维护。原作者与许可证信息见 `LICENSE` 和 `NOTICE.md`。

## 五层结构

1. **原始消息层**：保存真实发生的消息，作为可审计证据。
2. **事件层**：把连续对话整理为带消息 ID 的事件卡。
3. **长期事实层**：只从合格证据中提取身份、偏好与稳定习惯。
4. **召回层**：按主体、会话、语义与预算筛选相关记忆。
5. **上下文连续性层**：处理指代续聊和压缩后的话题衔接。

## 主要特性

- 私聊与群聊主体隔离，避免把群友的事实记到当前用户身上。
- 事件卡和长期事实保留证据消息 ID，可追溯来源。
- 严格事实路径使用 preview/commit 双阶段写入，先预览再提交。
- 召回采用硬边界、评分、去重和字符预算，避免整库塞进上下文。
- 高风险的 shadow/production 手动入口默认关闭，必须显式配置。
- 记忆数据继续使用 `fish-memory` 兼容目录，便于从原插件迁移。

## 安装

先卸载原版或其他同类分支，不要同时启用两个 `memory` 插件：

```sh
dsh plugin --profile web remove dsh-fish-memory
dsh plugin --profile web add github:hang27068/dsh-fishboard-memory
```

桌面 profile 请把 `web` 换成实际 profile 名。安装后重启一次 DSH，然后打开 **设置 → 鱼板记忆**。

## 更新

```sh
dsh plugin --profile web remove dsh-fishboard-memory
dsh plugin --profile web add github:hang27068/dsh-fishboard-memory
```

## 数据与隐私

- 仓库不包含任何个人聊天、QQ 号、会话 ID、API Key 或本机配置。
- 插件运行数据保存在用户自己的 DSH 目录，不会随源码发布。
- 公开问题反馈前请先清理日志中的消息正文、身份 ID 和模型凭据。

## 安全原则

- 模型只产生候选，程序负责 schema、主体、证据和 predicate 校验。
- 无法确定主体或证据时 fail closed，不猜测、不自动补写。
- 正式严格事实写入采用预览与提交分离，预览不会直接修改事实库。
- 运行前请自行备份 DSH 数据目录。

## 开发检查

```sh
node scripts/check.mjs
```

检查会验证 JavaScript 语法、包元数据、公开仓库归属，以及常见私人标识和绝对路径泄漏。

## 许可证

MIT。保留原项目版权声明；本分支的修改由 `hang27068` 维护。
