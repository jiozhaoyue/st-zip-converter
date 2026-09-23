# Thinking Guides

> **Purpose**: Expand your thinking to catch things you might not have considered.

---

## Why Thinking Guides?

**Most bugs and tech debt come from "didn't think of that"**, not from lack of skill:

- Didn't think about what happens at layer boundaries → cross-layer bugs
- Didn't think about code patterns repeating → duplicated code everywhere
- Didn't think about edge cases → runtime errors
- Didn't think about future maintainers → unreadable code

These guides help you **ask the right questions before coding**.

---

## Available Guides

| Guide | Purpose | When to Use |
|-------|---------|-------------|
| [Code Reuse Thinking Guide](./code-reuse-thinking-guide.md) | Identify patterns and reduce duplication | When you notice repeated patterns |
| [Cross-Layer Thinking Guide](./cross-layer-thinking-guide.md) | Think through data flow across layers | Features spanning multiple layers |
| [Tavern Datapack Formats](./tavern-datapack-formats.md) | 四平台包布局/导入语义/互转约定与环境教训 | 任何涉及 ST/L/TT/PT 数据搬移的任务 |
| [Subagent Collaboration](./subagent-collaboration.md) | 子代理来源唯一性 + 并行不阻塞 + 写权限边界 | **派发任何子代理之前**（含多链路并行审计/研究） |

---

## Quick Reference: Thinking Triggers

### When to Think About Cross-Layer Issues

- [ ] Feature touches 3+ layers (API, Service, Component, Database)
- [ ] Data format changes between layers
- [ ] Multiple consumers need the same data
- [ ] You're not sure where to put some logic
- [ ] You are adding an event kind, JSONL record, RPC payload, or config field
- [ ] UI / command code starts casting raw payload fields directly

→ Read [Cross-Layer Thinking Guide](./cross-layer-thinking-guide.md)

### When to Think About Code Reuse

- [ ] You're writing similar code to something that exists
- [ ] You see the same pattern repeated 3+ times
- [ ] You're adding a new field to multiple places
- [ ] **You're modifying any constant or config**
- [ ] **You're creating a new utility/helper function** ← Search first!
- [ ] Two files read the same untyped payload field with local casts
- [ ] Multiple branches update the same derived state from `kind` / `action`

→ Read [Code Reuse Thinking Guide](./code-reuse-thinking-guide.md)

### When Dispatching Subagents

- [ ] 用的是**本 agent 自带的子代理功能**？（不是 `trellis channel spawn` / pebrel / 外部 CLI agent）
- [ ] 多个子代理在**同一轮并发**发起？（不是逐个 await 串行）
- [ ] 主代理同轮也并行推进了自己的工作？
- [ ] 每个子代理任务写全了 范围 / 问题 / 期望输出 / 落盘路径？
- [ ] 有没有两个写者指向同一个文件？

→ Read [Subagent Collaboration](./subagent-collaboration.md)

### When Verifying AI Cross-Review Results

- [ ] Reviewer claims "user input can be malicious" → Check the actual data source (internal manifest? user config? external API?)
- [ ] Reviewer flags "missing validation" → Is the data from a trusted internal source?
- [ ] Reviewer says "behavior change" → Read the code comments — is it intentional design?
- [ ] Reviewer identifies a "bug" in test → Mentally delete the feature being tested — does the test still pass? If yes → tautological test

**Common AI reviewer false-positive patterns**:
1. **Trust boundary confusion**: Treating internal data (bundled JSON manifests) as untrusted external input
2. **Ignoring design comments**: Flagging intentional behavior documented in code comments as bugs
3. **Variable misreading**: Not tracing a variable to its actual definition (e.g., Map keyed by path vs name)

**Verification rule**: Every CRITICAL/WARNING finding must be verified against the actual code before prioritizing. Budget ~35% false-positive rate for AI reviews.

---

## Pre-Modification Rule (CRITICAL)

> **Before changing ANY value, ALWAYS search first!**

```bash
# Search for the value you're about to change
grep -r "value_to_change" .
```

This single habit prevents most "forgot to update X" bugs.

---

## Sub-Agent Dispatch Rule (CRITICAL)

> **派发子代理前必须核验模型，未指定时必须停下询问。**

1. 子代理一律使用低能力小模型，当前指定 `glm-5.3-flash`（2026-09-23 起）；禁用 Kimi K3 与旗舰模型。
2. 派发后立即核验实际生效模型（端点回执/日志）；若被路由到其他模型，立即停止并换模型重派。
   实测事故：显式指定 `DeepSeek-V4-Flash[free]` 后上游仍路由到 `gpt-5.6-sol`（2026-09-23）。
3. 未明确指定子代理模型时，**禁止**默认继承主线程旗舰模型；必须列出当前平台可用模型清单并请用户选定。
4. 并发 ≤3（免费端点实测 6 并发熔断）；子代理任务必须自包含（范围/问题/期望输出）。

详见 `AGENTS.md` L0-8。

---

## How to Use This Directory

1. **Before coding**: Skim the relevant thinking guide
2. **During coding**: If something feels repetitive or complex, check the guides
3. **After bugs**: Add new insights to the relevant guide (learn from mistakes)

---

## Contributing

Found a new "didn't think of that" moment? Add it to the relevant guide.

---

**Core Principle**: 30 minutes of thinking saves 3 hours of debugging.
