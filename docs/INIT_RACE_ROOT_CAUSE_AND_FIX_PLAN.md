# 初始化竞态根因与修复计划（v2.1.2 实验实锤版）

> 更新时间：2026-08-06 06:35
> 状态：✅ 根因已实锤，修复方案已三方对齐，**待执行**
> 实验版本：v2.1.2（[mount] 实例创建探针 + globalThis 模块级渲染计数器）
> 执行前提：休息充足后，按本文第六节顺序执行；P1 之前必须先做持久化通道验证实验

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

---

## 五、修复方案（已对齐，待执行）

### P0（必须，先做）

**1. 禁止空结果覆盖已有数据（统一守卫）**

所有加载（data / persona / memory）统一规则：

```js
if (result 为空 && oldState 非空) { 保留 oldState; return; }
```

具体：
- persona：`chars === 0` 直接 return，不 setPersona
- data：`extracted=无` 时不清空 dataState
- memory：空数组返回时不覆盖非空缓存

**2. 探测式等待 + 失败重试（替代盲等）**

- 进入页面先发轻量探测（如 loadMem），返回空壳则短间隔重试，直到返回非空或达上限
- ⚠️ 实验实证：**延迟 5 秒后的首次调用仍可能返回空壳**（22:18:24 调度 → 22:18:29 才执行 → 仍返回空）——纯 setTimeout 盲等无效，必须**重试直到非空**

### P1（随后）

**3. 持久化关键状态（persona / dataLoadedTs / memory 缓存）**

- ⚠️ **前置验证实验（30 秒，必须先做）**：确定 Operit 可靠的持久化通道
  - 已知：useState key 持久化部分失效；setEnv 跨进程读不到（worker 独立进程）
  - 实验：screen.js 写测试 key → 退出重进 → 读回，验证同进程内哪些通道可靠
- 确定通道后再实施，避免返工

**4. 缓存优先 + 后台刷新（stale-while-revalidate）**

- 进入 → 立即显示缓存（dataState 已验证跨实例保留 27e）→ 后台刷新 → 刷新失败保留缓存

**5. requestId 防旧请求覆盖（防御性）**

- 每次进入生成 requestId，回调携带；setState 前校验仍为最新请求，丢弃过期回调

**6. 空缓存时 loading UI 兜底**

- 首次进入无缓存时显示骨架屏 / "正在加载数据…"占位，避免裸空白

---

## 六、实施顺序与验收标准

### 实施顺序

1. **持久化通道验证实验**（30 秒，决定 P1 技术选型）
2. P0-1 空覆盖守卫（data / persona / memory 三处）
3. P0-2 探测式等待 + 失败重试
4. P1-3 关键状态持久化（按验证结果选通道）
5. P1-4 缓存优先 + 后台刷新
6. P1-5 requestId + P1-6 loading UI 兜底

### 验收标准

- 连续 10 次退出重进：白屏 / 未识别 / 假正在读取 = **0 次**
- 空壳响应不再清空任何已有数据
- worker 未启动 / 网络异常时：显示缓存 + 加载状态，**不白屏**
- dbg_ui.log 中不再出现 `set dataState=空 | old dataState=27e` 类覆盖记录

---

## 七、参考

- 实验 log：`logs/dbg_ui.log`（22:18 段，v2.1.2 三实例完整证据）
- 历史文档（假设阶段，机制细节以本文为准）：
  - `docs/Character_Memory_Frontend_Source_Review.md`
  - `docs/Character_Memory_Engine_review_notes.md`
- 第一层竞态记录：`docs/TOOLPKG_DEVELOPMENT.md` §4（v2.0.20）
