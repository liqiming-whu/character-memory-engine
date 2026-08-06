# 初始化竞态根因与修复计划（v2.1.2 实验实锤版）

> 更新时间：2026-08-06 19:20
> 状态：✅ **P0 全部完成并验证通过（v2.1.3 ~ v2.1.7）**；剩余 P1 待后续迭代
> 实验版本：v2.1.2（[mount] 实例创建探针 + globalThis 模块级渲染计数器）
> 执行结论：进入角色页不再空载/卡读取；正常加载转圈短暂保留（可接受）
> 追加认知：v2.1.6/v2.1.7 源码级实锤 **Operit 是 action 驱动渲染**（见第五节末补充）

---

## 一、问题现象

退出插件界面再进入，偶发出现：

- 白屏（数据区空白）
- "未识别角色卡"
- "正在读取"卡住

切 tab / 过一会儿 / 重进可恢复。长期存在，后端性能排查多次均无瓶颈。

---

## 二、历史排查过程

| 阶段 | 手段 | 结论 |
|---|---|---|
| 1 | 后端性能实测 | SQLite 查询 7-97ms、工具调用平均 16.8ms → **后端无瓶颈** |
| 2 | v2.1.1 三探针（state 写入 / render 快照 / requestId） | 问题类型锁定 **A（数据没返回）**；空壳结果覆盖已有 27 条数据；dataLoadedTs 持久化部分失效 |
| 3 | v2.1.2 mount 实验（本次） | **最终实锤根因**，见下 |

---

## 三、v2.1.2 实验设计与证据

### 实验设计

- **[mount] 实例创建探针**：每次组件实例创建输出 `[mount] 实例创建 tab=X`
- **globalThis 模块级渲染计数器** `__dbgRC`：同一模块内跨渲染递增；**模块被重新执行才归 1**（可区分"组件重建"与"整页/整模块重载"）

### 证据（22:18:24 - 22:18:57，三次进入）

**① 每次进入 = 整个 JS 模块重新执行**
```
22:18:24 [mount] 实例创建 r=1 → 渲染递增到 r=32
22:18:46 [mount] 实例创建 r=1 → 渲染递增到 r=18   ← r 归零
22:18:53 [mount] 实例创建 r=1 → 渲染递增          ← r 再次归零
```
globalThis 计数器归零 ⇒ **不只是组件重建，模块级状态全部重置**。Operit 每次进入插件界面都重新执行整个 JS 模块。

**② useState key 持久化"部分生效"，不可全信**
```
22:18:53 进入时：dataState=27e/6t/1c/25i  ← 跨实例保留了
             persona= / dataLoadedTs=0     ← 丢了
```
同一组件内不同 key 行为不一致：dataState 保留、persona 与守卫时间戳丢失。

**③ 新模块执行早期的工具调用高频返回"成功但空壳"**
```
实例① loadData → extracted=无（2ms）  → dataState 被清空 → 白屏
实例② loadData → extracted=27e ✓（31ms）→ 正常
实例③ loadData → extracted=无（23ms） → dataState 被清空 → 白屏
```
三个实例两次返回空壳（2/3 概率），且 2-23ms 快速返回；同秒内 worker 明明健康（memory=42 正常返回）。⇒ **工具调用环境（executor/调度）初始化竞态**。

**④ 空壳结果覆盖已有数据 = 白屏直接原因**
```
[state] set dataState=空 | old dataState=27e...（27 条）
```
**⑤ loadPersona 并发乱序 = "未识别角色卡"直接原因**
```
req#1 返回 chars=0（先到）→ persona 被置空 → 显示"未识别"
req#2 返回 chars=2（后到）→ 才恢复
```

---

## 四、根因结论：两级初始化竞态

### 第一层（已解决，v2.0.20）
Operit 重启早期 hiddenExec / proot executor 会话竞态 → `onAppCreate` 延迟 30s + `ensureWorkerUp` freshKey 自愈。**已解决，不动。**

### 第二层（本次实锤，待修复）
**Operit 每次进入插件界面重新执行整个 JS 模块；新模块执行早期的工具调用环境未就绪，约 2/3 概率返回"成功但空壳"的响应**（`extracted=无` / `chars=0`）。

### 叠加因素
1. useState key 持久化部分失效（dataState 保留 / persona、dataLoadedTs 丢失）
2. 空壳结果覆盖已有数据（白屏直接元凶）
3. 并发请求乱序返回（chars=0 覆盖 chars=2，未识别角色卡直接元凶）

> 升级认知：**不是 React 生命周期问题，而是 Operit JS Runtime 重载 + 工具初始化竞态 + 非可靠状态恢复 + 空结果覆盖。**

### 两层竞态 → 症状 → 修复 全链路映射

| 竞态层 | 机制 | 导致的 bug | 实施修复 | 验证 |
|---|---|---|---|---|
| 第一层：hiddenExec executor 会话竞态（v2.0.20） | Operit 重启早期创建坏会话，后续调用永久卡 | worker 不响应 → 界面转圈/卡死/ANR | `onAppCreate` 延迟 30s + `ensureWorkerUp` freshKey 自愈 | 重启后秒级拉起 |
| 第二层：JS 模块重载 + 工具初始化竞态（v2.1.2 实锤） | 每次进入重载整个 JS 模块；新模块早期工具调用 2/3 概率返回"成功但空壳" | **空加载（白屏）**：空壳覆盖已有 dataState | v2.1.3 空壳守卫（空结果绝不覆盖非空） | 5 次进入 0 空覆盖 |
| 叠加 1：空壳覆盖 + 并发乱序 | req#1 chars=0 先到覆盖 req#2 chars=2 | **"未识别角色卡"** | v2.1.3 守卫 + v2.1.4 消除 persona 并发 | 6 次进入 persona 单请求 |
| 叠加 2：相同值 setState 不触发重渲染 | `dataLoadedState[1](0)` 相同值写入无 render | render 驱动重试冻结 | v2.1.5 失败自驱重试 | 数据层恢复（暴露 UI 层问题） |
| 叠加 3：action 驱动渲染（v2.1.6 源码级实锤） | 异步 setState 只写 stateStore 不触发 UI 重绘 | **卡"正在读取"**（数据已恢复但 UI 不动） | v2.1.6 onLoad 窗口 + v2.1.7 tab 切换窗口（async + 600ms 保持订阅） | 直接进入/切 tab 均不再卡读取 |

---

## 五、修复方案（P0 已全部执行完毕）

### P0 实施记录（v2.1.3 ~ v2.1.7，均已实测验证）

| 版本 | 内容 | 验证结果 |
|---|---|---|
| v2.1.3 | 空覆盖守卫（data / persona / memory 三处） | 5 次进入 0 空覆盖 |
| v2.1.4 | 重试保险丝（退避 + 上限 + memory 成功才写时间戳 + 消除 persona 并发） | 6 次进入 100% 拦截、persona 单请求 |
| v2.1.5 | 失败自驱重试（不再依赖 render） | 数据层全恢复，但暴露 UI 不重绘 |
| v2.1.6 | onLoad action 链窗口（源码级实锤后第一刀） | 直接进入角色页不再卡"正在读取" |
| v2.1.7 | tab onClick 同样保持 action 链窗口 | 切 tab 渲染全通，不再卡读取 |

### 源码级补充认知（v2.1.6/v2.1.7 实锤）

**Operit compose_dsl UI 是 action 驱动渲染模型**（拉取官方源码 `JsComposeDslRuntimeScript.kt` / `JsComposeDslBridge.kt` / `ToolPkgComposeDslScreen.kt` 确认）：

- UI 树只在 ①初始渲染 ②action 分发 ③文本输入同步 ④显式 rerender 时重建
- **异步 setState（Promise/setTimeout 回调）只写 stateStore，不触发 UI 重绘**
- **action 分发期间（Promise pending）会订阅 stateChange → setState 触发"中间渲染"实时推送**；action 完成后订阅取消
- 这解释了"点重载/切 tab（走 action 链）有效、自动加载卡死（setTimeout 不在 action 链）"
- **修复模式：让关键加载进入 action 链窗口**（onLoad await + 600ms；tab onClick async + 600ms）

### P1 剩余项（待后续迭代）

**3. 持久化关键状态（persona / dataLoadedTs / memory 缓存）**
- ✅ 前置验证已完成（代码分析结论）：dataState 跨实例恢复靠 `ctx.setEnv('CACHED_ALL_DATA')` 兜底；**setEnv/getEnv 同上下文同步可靠，useState key 跨实例持久化基本不可信** → P1-3 选型确定用 setEnv 兜底模式
- 待实施：persona / dataLoadedTs / memory 也用 setEnv 兜底

**4. 缓存优先 + 后台刷新（stale-while-revalidate）**
**5. requestId 防旧请求覆盖（防御性）**
**6. 空缓存时 loading UI 兜底**（正常加载转圈已天然兜底，可评估是否增强）

---

## 六、实施顺序与验收标准

### 实施顺序（✅ = 已完成并验证）

1. ✅ **持久化通道验证**（代码分析完成，结论见五-3：setEnv 兜底模式）
2. ✅ P0-1 空覆盖守卫（v2.1.3）
3. ✅ P0-2 失败重试 + 保险丝（v2.1.4）+ 自驱重试（v2.1.5）
4. ✅ 补充：action 链渲染窗口（v2.1.6 onLoad / v2.1.7 tab 切换）
5. P1-3 关键状态持久化（setEnv 兜底，待实施）
6. P1-4 缓存优先 + 后台刷新
7. P1-5 requestId + P1-6 loading UI 兜底

### 验收标准（当前达成情况）

- 连续 10 次退出重进：白屏 / 未识别 / 假正在读取 = **0 次** —— ✅ 多次实测达成（仅保留正常加载转圈，时间短可接受）
- 空壳响应不再清空任何已有数据 —— ✅ v2.1.3 实测 5 次 0 空覆盖
- worker 未启动 / 网络异常时：显示缓存 + 加载状态，**不白屏** —— ✅（守卫 + 自驱重试 + 转圈兜底）
- dbg_ui.log 中不再出现 `set dataState=空 | old dataState=27e` 类覆盖记录 —— ✅ 已无覆盖记录

---

## 七、参考

- 实验 log：`logs/dbg_ui.log`（22:18 段，v2.1.2 三实例完整证据）
- 历史文档（假设阶段，机制细节以本文为准）：
  - `docs/Character_Memory_Frontend_Source_Review.md`
  - `docs/Character_Memory_Engine_review_notes.md`
- 第一层竞态记录：`docs/TOOLPKG_DEVELOPMENT.md` §4（v2.0.20）
