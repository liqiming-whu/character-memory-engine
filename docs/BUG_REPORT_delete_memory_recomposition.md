# Root Cause: Async action Promise chain broken — Screen state updates stop triggering recomposition

> Reproduced with `memory_engine:delete_memory`（delete button onClick 未返回 Promise）
> 状态：**根因已确认并修复** / 2026-08-07
> ⚠️ 结论更正：**这不是平台 bug，而是插件代码未遵守"异步 action 必须返回 Promise"规范**

## 最终结论（v2.2.2）

根因：删除按钮 `onClick: function() { deleteMemory(memory.id); }` **未返回 Promise**。

- Operit action 分发器只在等待事件处理器返回的 Promise 期间订阅 stateChange
- onClick 立即返回 undefined → action 窗口关闭 → `await ctx.callTool` 之后的 setState 只写 state store、不触发 recomposition
- 修复（一行）：`onClick: function() { return deleteMemory(memory.id); }`

开发规范已写入 `docs/DEVELOPMENT_GUIDELINES.md`。

## 1. 环境 Environment

- 平台：Operit Android Agent（2026-08）
- 插件：ToolPkg `com.operit.character_memory_engine`（UI 为 Compose DSL + `ctx.useState` / `ctx.callTool`）
- 界面：角色记忆页（多 tab 界面中的子 tab 组件）

## 2. 复现步骤 Reproduction

1. 在 ToolPkg 的 tab 组件内，点击"删除记忆"按钮
2. 按钮 onClick 中执行 `await ctx.callTool('memory_engine:delete_memory', { id })`
3. 工具返回成功（数据库软删除正确执行）后，调用 `useState` setter 更新列表状态（`memoriesState[1](filteredList)`）

## 3. 实际行为 Actual behavior

- 数据库删除成功、setState 已执行（日志可证）
- **但该 Screen 实例的后续 state 更新不再触发 recomposition**：渲染函数不再被调用（连此前每秒数次的常规渲染都停止）
- 约 8 秒后组件被 mount 重挂载，`useState` 恢复为**删除前的持久化旧快照**（列表"复活"），用户需要第二次点击或退出重进才看到正确结果

## 4. 预期行为 Expected behavior

- 与创建记忆一致：setState 后立即 recomposition，列表即时更新

## 5. 最小复现实验 Minimal reproduction（核心）

同一组件、同一 setter、同一数据流，仅改变工具调用：

| 操作 | 工具调用 | setState 结果 |
|---|---|---|
| 创建记忆 | `create_memory` | ✅ 正常刷新 |
| 模拟删除（跳过工具） | 无（纯本地 filter + setState） | ✅ 正常刷新 |
| 真实删除 | `delete_memory` | ❌ 不触发刷新 |

- **A. 真实删除**：`await ctx.callTool('delete_memory')` → setState 全部执行 → **零 recomposition**
- **B. 创建对照**：`await ctx.callTool('create_memory')` → setState 全部执行 → **立即 recomposition**
- **C. 跳过工具对照**：不调用任何工具，直接执行与 A 完全相同的本地 filter + setState → **立即 recomposition**

> 唯一变量是 `delete_memory` 工具调用本身。结论：**调用该特定工具后，当前 Screen 实例的 state 更新无法触发 recomposition**。根据现象推测，可能与平台内部组件状态同步、重建标记或 runtime 状态切换有关；mount 重挂载是后续的恢复动作而非原因。

## 6. 已排除项 Excluded

- 删除按钮逻辑 / filter 逻辑 / state setter 本身
- 数组引用与 equality 判断（`slice()` 新引用仍无效）
- await 后 setState 失效（延迟 120ms、10s 均无效，10s 后渲染循环正常但 setState 仍不触发）
- 多 setState 竞争（全新独立 useState 也不触发）
- mount 恢复覆盖（无 mount 发生时同样不触发）
- tool bridge 返回错配（返回链正确，数据/数据库均正确）

## 7. 日志证据 Log evidence

- 删除成功后：`[MEM] delete set len=5` → 其后**零渲染日志**
- 模拟删除：`[EXP6] direct firing` → **立即** `render r=32` → `[R] mem=5` ✓
- 同函数内、await 之前同步段的 setState 正常触发渲染（证明 setter 与渲染循环本身健康）

## 8. 请求确认 Request

1. 该现象是否为已知的平台行为/缺陷？`delete_memory` 这类"数据变更"工具调用返回后，平台是否对 Screen 实例做了重建标记或外部状态同步，导致代码侧 setState 被忽略？
2. `create_memory` 为何不触发该路径？
3. 是否有 API 层面的规避方案（如工具调用后显式请求刷新、或提供不冻结 state 通知的调用方式）？

复现环境与完整日志可随时提供。期望能得到官方确认或修复计划，谢谢！

---

## 附录：诊断历程（供官方/维护者参考）

### 实验序列

| 实验 | 做法 | 结果 |
|---|---|---|
| 实验0（探针版） | await 后直接 setState（墓碑/快照/新引用） | 执行，零渲染 |
| 实验1 | setState 延迟 120ms（绕 action window） | 执行，零渲染 |
| 实验2 | 全新独立 state + slice 新引用 | 执行，零渲染 |
| 实验3 | 延迟 10 秒（越过冻结/mount 期） | 执行，零渲染 |
| 实验6 | 跳过 delete_memory 工具调用（模拟删除） | ✅ 立即渲染 |
| 实验7 | delete 后调用普通工具（ping_worker）再 setState | ❌ 无法解锁，仍零渲染 |

### 实验7 补充结论

`delete_memory` 成功后、setState 前调用 `ping_worker`（普通工具），工具成功返回，但随后的 setState **依然不触发 recomposition**。说明：

- 不是"runtime 进入特殊状态、可由普通工具调用恢复"的状态机问题
- 更接近 **delete_memory 对当前 Screen 实例造成不可逆的 state 通知破坏（实例级污染）**，唯一恢复路径是平台重挂载（mount）

### 关键日志片段

```
# 真实删除（异常）
[del] click id=162 list=6 → render r=17/18（同步段 setState 有效）
[EXP2] direct firing before=6 newLen=5
[MEM] delete set len=5 id=162 → ★ 之后零渲染 ★

# 模拟删除（正常）
[del] click id=165 list=6
[EXP6] SIMULATE delete (tool call SKIPPED) id=165
[EXP6] direct firing before=6 newLen=5 simulate=1
→ render r=32 → [R] mem=5 ✓ 立即消失
```
