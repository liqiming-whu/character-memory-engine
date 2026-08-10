# Character Memory Engine（CME）完整代码审计报告

- 审计日期：2026-08-10
- 审计对象：Character Memory Engine（CME）
- ToolPkg ID：`com.operit.character_memory_engine`
- 插件版本：`v2.4.9`
- Worker 版本：`v2.1.9`
- Git 分支：`master`
- 审计时提交：`2cf5a1a`
- Git 仓库：`/root/cme_engine_clone`
- 部署副本：`/sdcard/Download/Operit/dev_package/Character-Memory-Engine`
- 审计方式：静态代码审查、语法检查、项目测试、隔离环境最小复现、实机只读运行状态核验
- 审计边界：本轮未修改源码、未烧录 ToolPkg、未重启 Worker、未执行线上恢复或破坏性操作

---

## 1. 执行摘要

CME 的总体架构方向合理：使用独立 SQLite 数据库作为角色记忆权威存储，在 proot Linux 的 ext4 文件系统中运行常驻 HTTP Worker，使用 sdcard 数据目录保存部署副本和热备；向量能力支持缺失时降级；Worker 启动链已经具备租约、互斥、健康检查和熔断保护。

但当前实现存在若干会直接影响数据正确性、恢复安全和 UI 稳定性的缺陷。本次审计确认：

- 严重问题（P0）：3 项
- 高风险问题（P1）：8 项
- 中风险问题（P2）：9 项
- 测试与维护缺口：多项

最优先处理的四类风险是：

1. 角色页在已有角色记忆时存在确定的渲染异常；
2. 自动分析失败后仍推进水位线，失败消息可能永久跳过；
3. 无效备份可通过校验并覆盖活动数据库；
4. 普通更新不会刷新语义哈希和向量索引，正文与检索索引会失去一致性。

本报告仅记录审计结果，没有对项目作任何源码修改。

---

## 2. 当前运行状态与基线验证

### 2.1 实机只读核验

审计时实机状态：

- Worker 在线：是
- Worker PID：`30394`
- Worker 报告版本：`2.1.9`
- Worker 报告 `vec_available=true`
- 活动数据库：`/root/character_memory_engine/engine.db`
- `PRAGMA quick_check`：`ok`
- 记忆总数：1310
- 有效记忆：549
- 软删除记忆：761
- Git 工作树：干净
- 审计前后 Worker PID 未改变

Worker `deploy_status` 报告：

- 项目 venv 正常；
- Worker 单实例运行，无重复进程；
- onnxruntime、sqlite-vec、tokenizers 可用；
- 模型文件存在；
- 数据库存在；
- 监听端口为 8765。

说明：Linux 系统 Python 的 sqlite3 未加载 vec0 扩展，因此用普通 Python 只读连接查询 `vec_items` 会提示 `no such module: vec0`；这不等同于正式 Worker 的向量能力不可用。正式 Worker 使用项目 venv，实机 health 返回 `vec_available=true`，向量专项测试也通过。

### 2.2 静态检查

以下检查均通过：

- `node --check main.js`
- `node --check packages/*.js`
- `node --check ui/memory_system_ui/*.js`
- `node --check ui/memory_system_ui/tabs/*.js`
- `python3 -m py_compile worker.py embed.py`
- `bash -n start_worker.sh`

### 2.3 自动测试

在隔离的 `/tmp/cme_audit` 副本中执行，避免测试导入 `worker.py` 时覆盖线上 PID 文件：

- 基础 Worker 测试：22/22 通过
- 向量专项测试：8/8 通过

### 2.4 ToolPkg 注册一致性

- METADATA 工具数：31
- 显式 `exports.*` 数：31
- 工具名集合完全一致
- `ping_js` 已同时存在于 METADATA 和 exports
- `manifest.json` 根入口与子包入口结构正常

现有测试全部通过，但没有覆盖本报告发现的大部分错误路径，因此不能用现有测试通过来否定这些缺陷。

---

## 3. 严重问题（P0）

## P0-1：角色页存在确定的渲染期异常

### 位置

- `ui/memory_system_ui/tabs/character.js:35-57`
- `ui/memory_system_ui/tabs/character.js:81`
- 调用入口：`ui/memory_system_ui/screen.js` 中 `characterTab.render(...)`

### 代码问题

角色页在声明并初始化 `localChangeState` 之前就读取：

```js
var localFresh = localChangeState[0] &&
  (Date.now() - localChangeState[0]) < 30000;
```

但该变量在后面才赋值：

```js
var localChangeState = ctx.useState('character_local_change_v3', 0);
```

`var` 只提升变量声明，不提升赋值。因此在第一次使用时，`localChangeState` 是 `undefined`。

当 `memoriesFromScreen` 中存在角色记忆、导致 `screenFiltered.length > 0` 时，会访问 `localChangeState[0]` 并抛出异常。

### 动态复现证据

使用最小模拟 ctx 调用 `character.render()`，传入一条角色记忆，得到：

```text
TypeError: Cannot read properties of undefined (reading '0')
at character.js:56:38
```

### 影响

- 角色已经存在记忆时，进入角色页可能渲染失败；
- 宿主若吞掉异常，可能表现为空白、加载失败或偶发页面失效；
- 与项目既往“角色页偶发加载异常”现象具有相关性，但尚未在 Operit UI 中重新进行针对性实机复现。

### 建议修复

1. 将 `localChangeState = ctx.useState(...)` 移到第一次使用之前；
2. 检查同一 render 中所有状态初始化顺序；
3. 清理 render 期间的 `setState` 副作用；
4. 增加“存在角色快照时渲染不抛异常”的最小测试。

---

## P0-2：自动分析失败后仍推进水位线，失败内容可能永久跳过

### 位置

- `packages/memory_engine.js:761-789`

### 代码问题

后台自动分析完成后会计算：

```js
var rOk = !!(r && r.success && (!r.data || r.data.success !== false));
```

但无论 `rOk` 是 true 还是 false，后续都会写入：

```js
tr2.watermarks[chatId] = maxTs;
tr2.lastAnalyzedAt = new Date().toISOString();
tr2.lastResult = rOk ? 'has_data' : 'failed';
```

这意味着以下失败都可能被标记为已经处理：

- LLM Endpoint 拒绝连接；
- 响应读取不完整；
- Worker HTTP 超时；
- LLM 返回不可解析 JSON；
- `analyze_chat` 返回 `success=false`。

下一次检测会依据水位线判定“没有新内容”，失败批次不会自动重试。

### 实际日志证据

最近日志中观察到：

- 多次 `ConnectionRefusedError`；
- 多次 `IncompleteRead`；
- 多次 Worker HTTP timeout/连接失败；
- 多次 `autoAnalyze 失败`。

因此，这不是仅靠推演得出的假设，而是会与当前已发生的外部调用失败叠加的数据完整性缺陷。

### 影响

- 对话消息可能从未成功提取，却被永久跨过；
- 用户看到自动分析失败后，即使网络恢复也未必重新处理；
- 角色长期记忆出现不可见的数据缺口。

### 建议修复

1. 仅在分析明确成功时推进水位线；
2. “成功但提取 0 条”应被视为成功，需要 Worker 明确返回 `analyzed=true`；
3. 失败时保留原水位线；
4. 记录失败次数、最后错误和下一次允许重试时间；
5. 使用有限重试与退避，防止同一坏批次无限重试；
6. 写水位线时使用读合并写或单写者机制，防止并发覆盖。

---

## P0-3：备份校验形同虚设，无效文件可覆盖数据库

### 位置

- `worker.py:1603-1626`：`inspect_engine()`
- `worker.py:1634-1701`：`restore_engine()`

### 代码问题

`inspect_engine()` 仅检查：

- ZIP 中存在 manifest；
- `format` 和 `version` 符合；
- 存在名为 `engine.db` 的文件。

没有验证：

- `engine.db` 是否为 SQLite 数据库；
- `PRAGMA quick_check/integrity_check`；
- 必需表和字段；
- manifest 文件清单和实际归档是否一致；
- 文件摘要；
- 数据库版本和迁移兼容性。

而 overwrite 恢复直接关闭当前请求连接并复制：

```python
conn.close()
shutil.copy(src_db, db_path)
return {"success": True, ...}
```

Worker 使用 `ThreadingHTTPServer`，其他请求可能仍持有活动数据库连接。`_RESTORE_LOCK` 只串行化恢复函数本身，不能阻止其他业务请求并发读写数据库。

### 动态复现证据

在隔离临时数据库中构造 ZIP：

- manifest 格式合法；
- `engine.db` 内容为纯文本 `not a sqlite database`。

实测：

```text
inspect_bad_db:
  success=True
  valid=True

restore_bad_db:
  success=True

post_restore_db_error:
  file is not a database
```

### 影响

- 损坏或伪造的备份可通过校验；
- overwrite 会破坏活动数据库；
- 并发连接可能继续写旧 inode，导致连接间数据视图分裂；
- 虽有 `.pre_restore.bak`，但当前流程不会在失败后自动回滚。

### 建议修复

1. 解压到临时目录；
2. 以只读方式打开备份数据库；
3. 执行 `PRAGMA quick_check` 或 `integrity_check`；
4. 校验 `memories/characters/relationships` 表和必要字段；
5. 校验 manifest 文件清单和摘要；
6. overwrite 前通过 SQLite backup API 创建一致的当前保护副本；
7. 使用全局数据库维护锁，阻止所有业务请求进入；
8. 或停止 Worker 后由外部安全恢复，再重启 Worker；
9. 在目标同目录写临时数据库并原子替换；
10. 替换后重新打开并执行 quick_check；
11. 任一步失败则自动回滚保护副本；
12. 在完成安全实现前，可临时禁用 overwrite，仅保留 merge。

---

## 4. 高风险问题（P1）

## P1-1：普通更新不会刷新 `semantic_hash` 和向量索引

### 位置

- `worker.py:690-721`

### 代码问题

`update_memory()` 修改标题和内容，但不更新：

- `semantic_hash`
- `vec_items`

`create_memory()` 的去重合并路径会刷新向量，但普通 update 路径不会。

### 动态复现

步骤：

1. 创建 `old-title / old-content`；
2. 更新为 `new-title / new-content`；
3. 再次创建旧内容。

实测结果：

```text
stale_hash_recreate = {
  deduped: True,
  total: 1,
  contents: ['old-content']
}
```

旧哈希错误命中已经修改的记录，并把新内容覆盖回旧内容。

### 影响

- 精确去重与实际正文不一致；
- 向量检索仍按旧文本召回；
- 修改后的新文本可能搜不到；
- 再次创建旧文本可能错误覆盖当前数据。

### 建议修复

- 标题、内容或角色归属变化时重新计算 `semantic_hash`；
- 同步重建或删除对应向量；
- 正文、哈希和向量在同一事务语义下更新；
- 增加“更新后新文本可检索、旧文本不再去重命中”的回归测试。

---

## P1-2：批量删除不会清理向量索引

### 位置

- `worker.py:771-792`

单条删除会删除 `vec_items` 对应 rowid；批量删除只设置 `is_deleted=1`，不会清理向量。

### 影响

- 形成孤立向量；
- 占据近邻候选池；
- 降低有效记忆召回率；
- 数据库持续膨胀。

当前数据库已有 761 条软删除，长期积累风险已具备现实意义。

### 建议修复

- 批量软删除时同步删除对应 rowid；
- 增加定期一致性检查：查找 `vec_items` 中没有有效 memory 的孤立项；
- 提供安全的向量索引重建工具。

---

## P1-3：`deploy_restart` 在线时实际不会重启 Worker

### 位置

- `packages/memory_engine.js:302-322`
- `packages/memory_engine.js:892-900`

### 代码问题

部署页调用：

```js
ensureWorkerUp(true)
```

但 `ensureWorkerUp(force)` 在 health 检查处没有考虑 `force`：

```js
if (ping && ping.success) {
  return { success: true, alreadyUp: true };
}
```

因此在线 Worker 下，“重启”只会同步数据库并立即返回成功，原 Worker 进程不会退出。

### 影响

- UI 提示“Worker 重启完成”，实际未重启；
- 新依赖、新解释器或需要重启才能生效的状态不会生效；
- 诊断结果误导用户。

### 建议修复

- `force=true` 时跳过在线即返回分支；
- 热备后校验 PID/cmdline，停止准确的 Worker；
- 等待旧端口释放；
- 启动新 Worker；
- 校验 PID 或 launchId 已变化，并校验 health。

---

## P1-4：全新安装缺少 `start_worker.sh` 的资源部署链

### 证据

- `start_worker.sh` 不在 `manifest.json.resources`；
- `main.js` 没有通过 `readResource` 读取它；
- `packages/memory_engine.js` 没有读取或部署它；
- 两个启动入口都直接执行 `/root/character_memory_engine/start_worker.sh`。

`start_worker.sh` 自己虽然会从 DATA_DIR 复制到 ROOT_DIR，但前提是 ROOT_DIR 中已经有脚本并成功启动，形成循环依赖。

### 影响

- 当前设备因历史部署残留而正常；
- 全新安装、清空 `/root/character_memory_engine`、迁移设备后可能无法自动启动；
- ToolPkg 包自身不具备从零部署 Worker 的完整性。

### 建议修复

1. 将 `start_worker.sh` 注册为 ToolPkg resource；
2. `deployWorkerToData()` 同步部署到 DATA_DIR 和 ROOT_DIR；
3. 启动前检查脚本存在、非空，并可被 bash 解析；
4. 增加 fresh install 测试：从空 ROOT_DIR 仅依赖 ToolPkg 资源完成部署和启动。

---

## P1-5：UI 全局串行 bridge 队列只覆盖部分调用

### 位置

- 全局队列：`ui/memory_system_ui/screen.js:176-182`
- 直接调用散布于：
  - `tabs/character.js`
  - `tabs/messages.js`
  - `tabs/deploy.js`
  - `tabs/todos.js`

### 代码问题

`screen.js` 使用 `globalThis.__cmeSerialCtx` 串行调用，但子 Tab 仍大量直接执行：

```js
ctx.callTool(...)
```

包括角色查询/创建/删除、消息列表/详情/分析、部署诊断/安装/重启、待办操作等。

角色页的本地 `Promise.race` 只让前端 Promise 超时，不能取消底层 `ctx.callTool`。超时后重试可能继续与未结束调用并发。

### 影响

- Operit bridge 多前端调用可能发生响应错配；
- 超时请求在底层继续运行并占用通道；
- 后续调用排队或收到错误响应；
- 日志调用也可能插入关键业务请求之间。

### 建议修复

- 把统一串行调用方法通过 `ctx/actions` 传给全部 Tab；
- 所有依赖返回值的调用进入同一全局队列；
- 日志类 fire-and-forget 调用限频或进入低优先级队列；
- 校验关键响应字段，不能只看 `success`。

---

## P1-6：多个 UI render 函数直接产生副作用

### 已确认位置

- `character.js:35-63`：render 中写状态；
- `character.js:93-112`：render 中墓碑过滤并写状态；
- `messages.js:66-93`：render 中启动异步列表调用；
- `messages.js` 详情分支：render 中拉详情；
- `messages.js:535-544`：render 到末项时 `setTimeout(handleLoadMore)`；
- `screen.js`：render 分支中存在多个 setTimeout 和异步加载调度。

### 影响

- render 重入会重复启动任务；
- 组件卸载后旧回调仍可能写状态；
- 渲染风暴时产生大量定时器和 bridge 调用；
- 依靠 ref 和时间闸只能缓解，不能从生命周期上保证正确性；
- 是此前 ANR 和渲染风暴问题反复出现的结构性风险。

### 建议修复

- render 只计算 UI；
- 首次加载放根节点 `onLoad`；
- 点击、切换、滚动行为放 action；
- 用 generation/request token 丢弃旧实例结果；
- 合并高频状态更新和渲染刷新。

---

## P1-7：`get_logs(path)` 可读取 Worker 能访问的任意文本文件

### 位置

- `worker.py:982-1007`
- Tool METADATA 中公开 `path` 参数

### 代码问题

```python
path = params.get("path") or LOG_PATH
with open(path, ...)
```

没有白名单或 realpath 边界检查。

### 动态复现

隔离环境调用：

```text
get_logs(path="/etc/hostname")
=> success=True
```

### 影响

Worker 以 proot root 身份运行，工具调用者可能读取 `/root`、`/etc` 等范围的文本文件，形成数据泄露能力。Worker 只监听 loopback 可以降低远程攻击面，但 Operit 工具层仍可能把该能力暴露给模型或 UI。

### 建议修复

- 删除任意 path 参数；
- 改为固定日志类型枚举，如 `engine/start_worker/cold_probe/ui`；
- 或校验 `realpath` 必须处于 `DATA_DIR/logs` 内。

---

## P1-8：LLM JSON 解析缺少重试、结构校验和可审计容错

### 位置

- `worker.py:1342-1379`
- `worker.py:1426-1454`

### 代码问题

当前只使用贪婪正则提取：

```python
m = re.search(r"\{[\s\S]*\}", content)
json.loads(m.group(0))
```

存在以下问题：

- markdown、前后解释、多 JSON 对象时容易误截；
- 截断 JSON 没有有限修复；
- 没有第二次“只修复 JSON”的模型请求；
- 未校验根节点必须为 dict；
- 未校验每个分类必须为数组；
- `items` 若为字符串，代码会按字符遍历；
- `dict(item)` 遇到错误类型会使整次分析失败；
- 没有保存脱敏后的原始失败响应和解析阶段供审计。

### 影响

- `analyze_chat` 偶发 `success=false`；
- 与 P0-2 叠加时，失败内容可能被水位线永久跳过；
- 外部接口已有 `IncompleteRead` 和拒绝连接日志，重试与错误分类不足。

### 建议修复

- 有限网络重试；
- 优先严格 `json.loads(content)`；
- 再处理 fenced code block；
- 使用 JSON decoder 的 raw_decode 或平衡括号扫描，不用贪婪正则；
- 做 schema 校验和字段归一化；
- 可选一次 JSON 修复重试；
- 记录脱敏后的响应摘要、错误阶段和请求 ID；
- 严格限制重试次数，禁止无限循环。

---

## 5. 中风险问题（P2）

## P2-1：长对话截断逻辑会扩增并重复文本

### 位置

- `worker.py:1393-1397`

代码条件是长度超过 12000，但会保留前 10000 和后 10000：

```python
chat_text = chat_text[:10000] + marker + chat_text[-10000:]
```

输入长度 13000 时，两段重叠 7000 字符，输出反而约为 20012 字符。

### 动态复现

```text
input=13000
output=20012
```

注释写的是“前后各保留 6000”，与实际代码不一致。

### 建议

设定最终总预算，按不重叠的前后窗口截取，例如前后各 6000，并单测 12001、13000、20000、超长输入。

---

## P2-2：列表查询的 `total` 忽略 `query`

### 位置

- `worker.py:550-585`

结果列表 SQL 使用了 LIKE 条件，但 total SQL 没有加入 query 条件。

### 动态复现

```text
returned=1
total=2
```

### 影响

分页数量、空态和统计信息不一致。

---

## P2-3：删除不存在 ID 仍返回成功

### 位置

- `worker.py:724-733`

动态复现：

```text
delete_memory(id=999999)
=> success=True
```

应检查 UPDATE 的 `rowcount`，不存在或已经删除时返回明确错误或幂等状态。

---

## P2-4：更新已软删除记忆仍返回成功

### 位置

- `worker.py:690-721`

初始 SELECT 不排除 `is_deleted=1`，UPDATE 又限定 `is_deleted=0`。因此：

1. 初始查询找到已删除行；
2. UPDATE 影响 0 行；
3. 再次 SELECT 返回旧行；
4. 函数返回 `success=True`。

已在隔离环境动态复现。

### 建议

初始查询和返回查询都限定有效记录，并校验 UPDATE rowcount。

---

## P2-5：共享 UI 配置不是原子写，存在并发丢更新

### 位置

- `worker.py:1228-1262`
- `worker.py:1274-1302`
- `main.js:393-404`

`save_ui_state()` 和 `set_injection_settings()` 都以读改写方式操作同一个 `last_ui_state.json`，但没有：

- 同目录临时文件；
- `os.replace`；
- 共享锁；
- parse 失败保留旧值。

`memory_injection_history.json` 也直接覆盖写。

### 影响

- 两请求并发时后写覆盖先写；
- 写入中断可能留下半个 JSON；
- parse 失败后按空对象重写，可能丢失原有 injection/UI 配置。

### 建议

- 使用同一把进程内锁；
- 同目录临时文件写入、flush/fsync 后 `os.replace`；
- 解析失败有限重试并保留旧文件；
- 单写者或版本号避免丢更新。

---

## P2-6：启动脚本可能误杀其他项目的 `worker.py`

### 位置

- `start_worker.sh:57-61`
- `worker.py:_find_worker_processes()`

当前 `/proc` 遍历只要 cmdline 包含 `worker.py` 就可能 kill，匹配范围过宽。

### 影响

可能误杀其他插件或项目的同名 Worker。

### 建议

同时校验：

- 完整脚本路径 `/root/character_memory_engine/worker.py`；
- `--port 8765`；
- 数据库路径；
- PID 文件内容与 cmdline 一致。

---

## P2-7：所有业务失败都会尝试拉起 Worker

### 位置

- `packages/memory_engine.js:445-454`

当前只要响应 `success=false`，就调用 `ensureWorkerUp()`。因此参数错误、memory not found、备份错误、LLM 配置错误等业务失败也会进入 Worker 拉起链。

### 影响

Worker 离线或 terminal 通道异常时，一个明确业务错误可能演变成 45 秒轮询或 hiddenExec 熔断。

### 建议

仅对以下错误触发拉起：

- 连接拒绝；
- 连接超时；
- Worker unavailable 专用错误码；
- health 明确失败。

业务错误直接返回，不启动 Worker。

---

## P2-8：HTTP 请求体没有大小限制

### 位置

- `worker.py:1768-1779`

代码直接读取客户端声明的全部 `Content-Length`。虽然 Worker 只监听 `127.0.0.1`，仍应限制请求大小，避免错误调用造成内存压力。

### 建议

设定合理上限，例如 2–8 MiB，超过后返回 413 或结构化错误。

---

## P2-9：日志永久追加，无轮转

审计时日志目录约 1.2 MiB，包含：

- `engine.log`：约 264 KiB；
- `dbg_call.log`：约 304 KiB；
- `dbg_ui.log.bak`：约 557 KiB；
- 其他探针和启动日志。

目前体积不大，但代码明确采用永久追加。长期运行会持续增长。

### 建议

- 单文件达到阈值后轮转；
- 保留有限份数；
- 稳定版本降低 `dbg_call/dbg_ui` 日志量；
- 对包含对话 ID、模型错误响应的日志执行最小化和脱敏。

---

## 6. 其他设计与维护观察

### 6.1 `worker.py` 导入阶段存在副作用

模块顶层会写：

```text
/root/character_memory_engine/worker.pid
```

因此直接执行项目测试并 import `worker`，可能把线上 Worker PID 文件覆盖成测试进程 PID。

本次审计在 `/tmp/cme_audit` 中修改探针/PID 路径后执行测试，避免污染线上状态。

建议将 PID 写入和启动探针移入 `main()` 的服务启动分支，import 阶段不得写线上文件。

### 6.2 启动架构注释存在历史过时内容

`main.js` 顶部仍有“CLI 架构、Worker 不常驻”的旧注释，而当前实现实际是常驻 HTTP Worker。此类注释会误导后续维护者。

### 6.3 数据库初始化吞掉单条 DDL 错误

`init_db()` 对每条 SQL 单独 try/rollback，但未记录失败语句。若基础表或索引创建失败，启动仍可能继续，后续只在业务调用时暴露。

建议基础表失败应记录具体 SQL 并中止启动；只有可选 vec0 表可以降级。

### 6.4 输入参数缺少统一边界校验

多个接口直接执行：

```python
int(params.get("limit") or ...)
```

没有统一限制 limit、offset、字符串长度和负数。建议建立轻量参数校验函数，避免超大查询或错误类型导致异常。

---

## 7. 测试覆盖缺口

现有测试覆盖基础 CRUD、文本去重、角色隔离、六类数据和基础向量检索，但没有覆盖：

1. 更新后哈希刷新；
2. 更新后向量刷新；
3. 更新已删除记录；
4. 删除不存在 ID；
5. 批量删除清理向量；
6. query total 一致性；
7. 长文本截断边界；
8. LLM markdown JSON；
9. LLM 截断/多对象/错误类型；
10. 网络失败有限重试；
11. 自动分析失败不推进水位线；
12. 成功但 0 条提取时推进水位线；
13. 无效 SQLite 备份检查；
14. overwrite 恢复并发与回滚；
15. fresh install 部署 `start_worker.sh`；
16. 强制重启 PID 变化；
17. 角色页已有记忆时渲染；
18. render 纯度；
19. bridge 全局串行覆盖；
20. UI 状态原子写并发。

---

## 8. 建议修复顺序

## 第一批：阻断严重数据和 UI 风险

1. 修复角色页 `localChangeState` 初始化顺序；
2. 自动分析失败时禁止推进水位线；
3. 暂时禁用不安全 overwrite，补 SQLite 完整性和结构校验；
4. `update_memory()` 同步刷新语义哈希和向量；
5. 修正 `deploy_restart(force)` 的真实重启语义。

### 第一批成功标准

- 角色页存在历史记忆时可稳定打开；
- 模拟 LLM 失败后水位线不变化，恢复后能重试；
- 非 SQLite 备份无法通过 inspect 和 restore；
- 更新后新文本可检索，旧文本不再错误去重；
- 点击重启后 PID 或 launchId 确实变化。

## 第二批：启动和前端稳定性

6. 将 `start_worker.sh` 纳入 ToolPkg resource 和部署链；
7. 所有 UI `callTool` 进入同一全局串行队列；
8. 移除 render 中工具调用、定时器和状态写入；
9. 增加 LLM JSON 有限重试、结构校验和审计错误；
10. `last_ui_state.json` 与注入历史改为原子写。

## 第三批：边界、安全与维护性

11. 限制 `get_logs` 路径；
12. 批量删除清理向量；
13. 修正长文本截断、query total、错误返回语义；
14. 收紧进程匹配和 HTTP 请求体；
15. 增加日志轮转；
16. 移除 import 阶段副作用；
17. 补齐回归测试和 fresh install 测试。

---

## 9. 架构评价

### 合理之处

- CME 与 Operit 官方 Memory 解耦，保持独立角色记忆存储；
- SQLite 是明确的数据权威；
- 活动数据库在 `/root` ext4 上运行，避免 sdcard 上 WAL 不稳定；
- sdcard 副本通过 SQLite backup API 热备；
- Worker 只监听 `127.0.0.1`；
- 向量扩展缺失时可以降级；
- Worker 启动具有 health、租约、互斥、轻提交和熔断机制；
- ToolPkg 工具注册当前完整一致；
- 归档布局和 manifest 主结构符合 ToolPkg 规范。

### 当前主要结构性风险

- 失败状态和成功状态没有严格分离；
- 正文、语义哈希和向量索引没有统一一致性边界；
- render 闭包仍承担状态同步和异步调度；
- 多个模块绕过共享 bridge 队列；
- 恢复流程没有建立真正的数据库维护期；
- 共享 JSON 状态缺少原子写和单写者规则；
- 启动脚本依赖历史残留，不满足从零部署。

---

## 10. 最终结论

CME 当前不是“无法运行”的项目：实机 Worker、数据库、向量能力和现有基础测试均正常，主架构也具备继续维护的价值。

但项目存在数个已经通过动态复现确认的正确性缺陷，特别是：

- 角色页已有数据时可能直接渲染异常；
- 自动分析失败仍推进水位线；
- 无效备份可覆盖并破坏数据库；
- 更新后索引与正文不一致；
- 部署页重启操作可能是假成功；
- fresh install 缺少启动脚本部署链。

建议采用“小批次、可回滚、每批独立测试与实机验证”的方式修复，不要一次性重构整个前端。第一批应优先保护用户数据和水位线，再处理 UI 生命周期与 bridge 串行化。

---

## 11. 审计证据摘要

本轮已实际执行或确认：

- 读取 CME 项目规则和开发计划；
- 遍历受 Git 跟踪的项目文件；
- 审查 `main.js`、`packages/memory_engine.js`、`worker.py`、`start_worker.sh` 和各 UI Tab；
- JS、Python、Shell 语法检查通过；
- 基础测试 22/22 通过；
- 向量测试 8/8 通过；
- Tool METADATA 与 exports 为 31/31 完全对齐；
- 角色页异常动态复现；
- 更新后旧哈希错误命中动态复现；
- query total 不一致动态复现；
- 删除不存在 ID 返回成功动态复现；
- 更新已删除记录返回成功动态复现；
- 13000 字符被截断为约 20012 字符动态复现；
- `get_logs` 任意路径读取动态复现；
- 非 SQLite 备份通过校验并破坏隔离数据库动态复现；
- 实机 Worker health 和 deploy status 只读核验；
- 实机数据库 quick_check 为 ok；
- 审计后 Git 工作树保持干净，Worker PID 未变化。

报告结束。
