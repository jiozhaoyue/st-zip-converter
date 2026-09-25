# OQ-1 答案：ST 1.19.0 的「导入」到底能做到什么

> 日期：2026-09-26 ｜ 取证对象：`Instance/Dev/SillyTavern`（`06bde939f` / sillytavern 1.19.0）
> 结论：**设计文档里那条假设是错的** —— ST **没有**整包导入，也**没有**整合的「导入用户数据」UI。

## 1. 否证：ST 不提供整包恢复

`src/endpoints/users-private.js` 的全部路由：

```
POST /logout   GET /me   POST /change-avatar   POST /change-password
POST /backup   POST /reset-settings   POST /change-name
POST /reset-step1   POST /reset-step2
```

**只有 `/backup`（导出），没有任何 import/restore。** 与 `src/ui/host-bridge.js:66` 的黑盒实测一致
（「ST 1.19.0：`/api/users/restore` 与 `/api/users/restore-backup` 两者**均为 404**」）。

前端同样只有导出：`public/scripts/user.js:255 backupUserData(handle, callback)`，
`.userBackupButton` 的 click 处理器（`:694`、`:801`）只调它。**仓内搜不到任何 user-data import 实现。**

⇒ **`design.md` §5.2 原写「ST 目标必须走浏览器端逐类目导入（宿主原生 UI）」，
其中「宿主原生 UI」并不存在** —— 该表述需更正为「逐类目**端点**导入，无整合 UI」。

## 2. 实存的可导入面（逐类目，无整包）

| 类目 | 端点 | 备注 |
| --- | --- | --- |
| 角色卡 | `POST /api/characters/import` | `src/endpoints/characters.js:1560` |
| 聊天 | `POST /api/chats/import` | `src/endpoints/chats.js:771`，**带 `validateAvatarUrlMiddleware`** |
| 群聊 | `POST /api/chats/group/import` | `src/endpoints/chats.js:751` |
| 世界书 | `POST /api/worldinfo/import` | `src/endpoints/worldinfo.js:99` |
| 设置 | `POST /api/settings/save` | `src/endpoints/settings.js:206`（是 save，不是 bulk import） |
| 背景 | `POST /api/backgrounds/upload` | `src/endpoints/backgrounds.js:135`（**逐文件**） |
| 预设 / instruct / 主题 / QuickReplies… | —— | **未找到批量导入端点** |

## 3. 由此产生的硬约束（若将来要脚本化 ST 导入）

1. **必须是有序的多次调用**，不是一次恢复：Real Luker 侧是 430 角色卡 + 1029 聊天 + 21 世界书 +
   23 背景 + 1 settings —— 合计约 **1500 次**请求量级。
2. **顺序强制**：`chats/import` 走 `validateAvatarUrlMiddleware` ⇒ **必须先导角色卡**，
   否则聊天找不到归属角色而被拒。
3. **覆盖语义由各端点自己决定**：`/import` 类端点多为「新增 / 同名冲突处理」语义，
   与 U-3「覆盖同名、不删独有」**不保证一致**，需逐端点核实（本次未做）。
4. **设置类目无 bulk 通道**：`settings/save` 会**整份替换** settings.json —— 与「不删独有」冲突
   （目标实例原有的自定义项会丢），必须单独设计（例如先读回目标 settings 再合并后写）。
5. 预设 / 主题 / QuickReplies / instruct 等**没有导入端点** ⇒ 在 ST 目标上**不可通过 API 同步**。

## 4. 对本任务的影响

- `design.md` §5.2 的 ST 通道需重写为上面的端点表，并**明确标注 3/4/5 三条硬约束**；
- AC-2 的「源覆盖率 100%」在 ST 目标上**不可达**（预设/主题等类目没有导入通道）⇒
  ST 侧验收标准必须按**可达类目**折算，不能照搬 Luker 侧的标准；
- **这是本任务阶段 3 的第二个独立阻塞**（第一个是产品缺陷 E），且它与 E 无关 ——
  即使 E 修好，ST 目标的同步仍需按上面重设计。
