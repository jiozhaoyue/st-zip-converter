# 扩展清单与 Git 语义设计草案

## 原则

清单模式解决“轻量迁移 + 在线安装”，FULL 模式解决“离线完整可用”。两者可共享元数据，但不能互相假定。

## 建议数据契约

每个扩展条目至少包含：

- `name`：宿主目录名（稳定标识）
- `displayName` / `description`：展示信息
- `url` / `branch` / `commit`：可确定的安装来源线索
- `sourceKind`：`git` / `manifest-homepage` / `unknown`
- `availability`：`embedded` / `manifest-only` / `unavailable`
- `notes`：无法安装、重复、已存在等用户可见提示

## 与 Git 瘦身的组合

- `full + keep`：实体与 `.git` 全保留，现有行为。
- `full + strip`：实体保留，`.git` 剔除；在线更新能力在目标端丢失，除非用户重新 clone。
- `full + minimal`：保留识别元数据，剔除对象存储；可行性由 `09-22-extension-git-slim` 的 Dev 实测决定。
- `manifest`：实体不打包，恢复后只能按 URL 在线安装；`gitMode` 无实际作用，UI 应禁用或说明。

## 实施门槛

开始实现前必须完成 `09-22-extension-git-slim` 的 OQ-1 实测结论，或明确把 `minimal` 从 MVP 排除。
