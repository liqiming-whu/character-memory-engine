# Operit 插件开发规范（本项目）

> 来源：v2.2.2 删除刷新 bug 根因闭环（2026-08-07）
> 完整排查过程见 `BUG_REPORT_delete_memory_recomposition.md`

## 核心规范：异步 action 必须返回 Promise

**规则**：所有在异步操作完成后更新 UI 的事件处理器（onClick / onLoad / onChange 等），都必须把 Promise 返回给宿主。不要在事件回调中直接调用异步函数而丢弃其返回值。

### 错误写法（fire-and-forget）

```js
// ❌ onClick 立即返回 undefined → Operit action 窗口提前关闭
onClick: function () {
  deleteMemory(memory.id);
}
```

### 正确写法

```js
// ✅ 把 Promise 返回给 Operit（推荐，结构最简单）
onClick: function () {
  return deleteMemory(memory.id);
}

// ✅ 或 async 包装
onClick: async function () {
  await deleteMemory(memory.id);
}

// ✅ 直接传函数引用（自然返回 Promise）
onClick: createMemory
```

### 为什么重要

Operit 的 action 分发器**只在等待事件处理器返回的 Promise 期间**订阅 stateChange / recomposition。若不返回 Promise：

```
onClick → 调用异步函数但不 return → onClick 立即返回 undefined
→ Operit 认为 action 已结束 → 关闭 stateChange 监听窗口
→ 工具调用完成 → await 后的 setter 执行并写入状态
→ 但不触发界面重渲染（界面停在旧画面）
```

**隐蔽性**：异步函数确实执行了、工具调用确实成功了、setter 确实调用了、state store 甚至已变化——只是 UI 不刷新。极易被误判为渲染器 bug、缓存问题、数组 diff 或工具类型问题。

### 排查清单（新代码必查）

- `onClick: function () { someAsyncFunction(); }` → 加 return
- `onLoad: function () { loadData(); }` → 加 return
- `onChange: function (value) { saveData(value); }` → 加 return
- `ctx.callTool(...).then(...)` 链 → 整个链 return
- 凡被调用函数是 async 或返回 `ctx.callTool(...)` 的 Promise，必须检查是否需要 return

### 对照经验

- `onClick: createMemory`（直接传引用）→ 正常（返回值即 Promise）
- `onClick: function() { deleteMemory(id); }`（包装且不 return）→ 删除"要点两次"（await 后 setState 失效）
- 模拟删除（跳过 await、全程同步）→ 正常（同步段在 action 窗口内）
- 延迟 setState / 额外工具调用均无法恢复（窗口已关闭，无法事后补救）

## 其他项目内约定（摘要）

- Row `spacing` 参数在本渲染器不可靠 → 按钮间距用显式 `UI.Spacer({ width })`
- `surfaceContainerHighest` 颜色键不存在 → 未选中按钮用 `surfaceContainerHigh`
- 本地变更后 30 秒内禁止 screen 快照覆盖 / loadOnEnter 自动加载（防旧数据救回）
- 删除/创建后本地立即更新列表 + 写墓碑（useState 跨 mount 持久）+ 模块级快照（渲染时强制应用）
- onClick 双触发现象 → 模块级防重入锁（2 秒窗口）
