# Operit Hidden Terminal 生命周期（架构参考）

> 2026-08-10 基于源码审计（`reports/codex/cme-session-leak-audit.md`）整理的架构知识。说明 hiddenExec 会话如何创建、复用、泄漏与回收，供后续平台级修复与插件开发参考。

## 一、进程模型

hiddenExec 会话的完整进程栈：

```text
Android/Java ProcessBuilder
└─ host bash -c "source common.sh && login_ubuntu ..."  （随后 exec）
   └─ proot
      └─ /bin/bash -lc "echo LOGIN_SUCCESSFUL; echo TERMINAL_READY; eval ..."
         └─ /bin/bash --noprofile --norc                 （持久 hidden shell）
            └─ setsid /bin/bash /tmp/operit_hidden_*.sh （一次命令）
```

- 顶层 `bash -lc` 等待持久子 bash → `do_wait`（设计如此，不一定是坏）。
- 持久子 bash 空闲从 stdin/pipe 等命令 → `pipe_read`/`do_select`（设计如此）。
- **`S + do_wait/pipe_read/do_select` 只能识别「像一条 hidden shell 进程树」，不能单独证明坏了**。判坏需结合 registry/owner 是否存在、ready/marker 往返、活跃 native tool call、PID/starttime 归属。

## 二、创建与复用（TerminalCore）

- `Terminal.executeHiddenCommand()` → 全局 `TerminalManager` → singleton `LocalTerminalProvider`（`TerminalManager.kt:1360-1379`）。
- provider 以 `executorKey` 查 `hiddenExecShells` Map，**只用 `process.isAlive` 判定可复用**，无协议级 ping / 管道可写性 / reader 健康检查（`LocalTerminalProvider.kt:186-205`）。
- 不存在时启动宿主 bash（`login_ubuntu '/bin/bash --noprofile --norc'`），reader 协程读输出，`awaitHiddenExecReady()` 最多等 **30 秒**直到 `TERMINAL_READY`（`LocalTerminalProvider.kt:208-258,261-305`）。
- ready 后命令写入持久子 bash：包装成临时脚本，`setsid /bin/bash ... &`，父 shell `wait` 到 END marker（`LocalTerminalProvider.kt:507-527`）。

## 三、已知泄漏点

1. **创建期失败空操作**（确定缺陷）：`createHiddenExecShell()` 失败时调 `closeHiddenExecShell(key)`，但 shell 尚未写入 Map → 关闭空操作，进程树失去 owner（`LocalTerminalProvider.kt:186-205,483-492`）。
2. **三套 timeout 不一致**：CME 5s/7s vs native ready 30s；JS 超时不取消 native，还能漂移新 key。
3. **两套 registry 分离**：hidden shell 在私有 `hiddenExecShells`，可见会话在 `SessionManager`；无 hidden executor 的 list/close API。
4. **全量清理路径不可靠**：仅 `Application.onTerminate()`（生产环境不可靠）。

## 四、回收语义（三种「重启」）

| 场景 | 行为 |
|---|---|
| Activity 重建/插件 JS VM 重建 | App 进程仍在；TerminalManager singleton、Map、runBlocking、proot 子进程都继续存在 |
| App 进程被杀后重建 | Java singleton/Map/Process handle 丢失；proot/bash 是独立进程实体，新进程无法从 /proc 重建或清理旧 hidden registry |
| force-stop / UID 级清理 | 通常比普通重启彻底，但厂商行为不可由仓库源码证明 |

## 五、与插件开发的约定

- **hiddenExec 只适合短命令**：长任务/取消调用可能触发泄漏链（2026-08-10 实测：长调用被终止 → 残留 proot/bash → hiddenExec 全局挂起 → 需 /proc 级手工清理，且跨重启残留）。
- **长任务用持久 terminal session**（`terminal.create` + `terminal.input` 投递 + 状态文件查进度），不要用 hiddenExec 承载。
- **不能用 hiddenExec 自查/清理 hiddenExec**（通道坏时自相矛盾）；清理应由平台层 owner-scoped 完成。
- 判坏会话不能只看 `do_wait/pipe_read`，要结合 registry/owner/活跃调用。

## 六、修复蓝图（P0/P1，来自审计报告）

- P0：创建失败直接关闭局部 shell（最小且必须）。
- P0-B：统一 timeout 覆盖完整调用 + 可传播取消。
- P0-C：启动前 owner-scoped 查询/定向清理（hiddenExec 下层）。
- P0-D：保存 root PID/child PGID + `/proc` starttime 生命周期 registry。
- P1：持久 registry + 内核锁处理跨重启；收敛插件侧 freshKey/重试；修正 worker 锁。

详见 `BUG_HISTORY/2026-08-10-cme-session-leak.md` 与原始报告。