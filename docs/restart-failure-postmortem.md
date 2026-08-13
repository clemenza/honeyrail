# 重启失败复盘报告

## 概述

**日期：** 2026-06-25
**项目：** HoneyRail (local runtime, port 4177)
**脚本：** `scripts/restart.sh` → `scripts/stop.sh` + `scripts/start.sh`
**启动方式：** `npm run ops:restart`

## 现象

执行 `npm run ops:restart`（即 `scripts/restart.sh`）后：

```
tmux session 'agw_server' is not running.
Building HoneyRail frontend and checking backend types...
...
✓ built in 1.46s
HoneyRail did not start listening on port 4177. Recent log:
tail: npm_start.log: No such file or directory
```

关键异常信号：
1. ✅ 构建成功（`tsc --noEmit` + `vite build`）
2. ❌ tmux 会话存在但端口 4177 无监听
3. ❌ `npm_start.log` 不存在（或内容为空）
4. ✅ 手动执行 `node ... server/index.ts` 能正常启动

## 排查过程

### 第一阶段：收集状态

首先确认当前进程状态：

- `scripts/status.sh` 报告 tmux: not running, port: not listening
- `npm_start.log` 文件存在但内容为**上一次**成功启动的日志（PID 74325），不是本次启动的日志
- `tmux has-session -t agw_server` 返回 false

这意味着旧服务已经不在了，但重启后新服务也没起来。

### 第二阶段：复现失败

直接运行 `bash scripts/restart.sh`：

```
Found stale tmux session 'agw_server' without port 4177 listener; recreating it.
Building...
✓ built in 1.46s
HoneyRail did not start listening on port 4177. Recent log:
tail: npm_start.log: No such file or directory
```

日志文件被删了！说明 `npm_start.log` 被 `start.sh` 重定向 `> $LOG_Q 2>&1` 清空，但新的 node 进程没有任何输出写入。这里有两个可能：
1. node 进程根本没启动
2. node 进程启动了但立刻崩溃，错误输出也被重定向但写不进去

### 第三阶段：手动测试 node 命令

直接运行 `start.sh` 中的 node 启动命令：

```bash
node --require .../preflight.cjs --import file://.../loader.mjs server/index.ts
```

输出：
```
Error: listen EADDRINUSE: address already in use 0.0.0.0:4177
```

**找到关键线索了！** 端口 4177 已被占用的，但 `lsof -sTCP:LISTEN` 却没检测到。进一步检查发现有一个孤儿 node 进程（PID 74325）在监听。

### 第四阶段：发现孤儿进程

~~~bash
$ lsof -nP -iTCP:4177
COMMAND   PID   USER   FD   TYPE  DEVICE  NODE
node    74325 humezhang  19u  IPv4  ...  TCP *:4177 (LISTEN)
~~~

这个进程是**不属于任何 tmux session** 的孤儿进程。`lsof -sTCP:LISTEN` 有时能检测到它，有时检测不到——可能是因为进程状态在 S+ (foreground process group) 和 S (detached) 之间变化。

### 第五阶段：关联源码分析

查看 `scripts/stop.sh` 逻辑：

```bash
# 1. kill tmux session
"$TMUX_BIN" kill-session -t "$SESSION_NAME"

# 2. 检查端口
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Warning: something is still listening on port $PORT:" >&2
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2 || true
  exit 1     # ← 直接退出！没有杀孤儿进程
fi
```

问题暴露：
- stop.sh 只杀了 tmux session，**不处理孤儿进程**
- 端口仍有进程监听 → `exit 1`
- `restart.sh` 用 `|| true` 吞掉了这个错误，继续执行 start.sh
- start.sh 创建新 tmux session + 启动新 node → **EADDRINUSE** → 崩溃
- 日志文件被清空（`>` 重定向）或根本来不及写

### 第六阶段：验证修复

清理环境后，修复 stop.sh，加入：
1. 主动查杀孤儿进程（`lsof -t | xargs kill`）
2. 轮询等待端口释放（最多 5 秒）
3. 最后才检查确认

修复后测试：
- `bash scripts/start.sh` → ✅ 成功启动
- `bash scripts/restart.sh`（从已运行状态）→ ✅ 停旧→启新，全部正常
- `bash scripts/restart.sh`（从停止状态）→ ✅ 直接启动

## 根因总结

```
             ┌──────────────────┐
             │ 某次异常退出/调试 │
             │  产生孤儿 node   │
             └────────┬─────────┘
                      ▼
             ┌──────────────────┐
             │ 孤儿占据 port    │
             │ 4177 (LISTEN)    │
             └────────┬─────────┘
                      ▼
    ┌──────────────────────────────────┐
    │ restart.sh                       │
    │  ├── stop.sh: kill tmux session  │
    │  │    └── port still in use → 1  │
    │  │    (|| true 吞掉错误)         │
    │  └── start.sh:                   │
    │       ├── build ✓                │
    │       └── new node → EADDRINUSE  │
    │            → 崩溃, 无日志        │
    └──────────────────────────────────┘
                      ▼
             ┌──────────────────┐
             │ 重启失败          │
             │ 无任何有用的日志  │ ← 最迷惑人的地方
             └──────────────────┘
```

**关键教训：** 日志文件被清空但新进程没来得及写入，是排查中最迷惑的点。`start.sh` 用 `>` 重定向覆盖日志文件，如果新 node 立刻崩溃（EADDRINUSE），崩溃信息虽然也被重定向到日志文件，但如果有多个进程同时写同一个日志文件，或者文件打开失败，日志可能丢失。

## 修复内容

### `scripts/stop.sh`

| 改动 | 说明 |
|------|------|
| 新增孤儿进程查杀 | `lsof -t \| xargs kill` 杀掉端口上的孤儿进程 |
| 新增端口释放等待 | 最多等 5 秒，轮询确认端口真正空闲 |
| 保留最终检查 | 如果端口仍然被占（强杀不掉），才报错退出 |

### ✨ Diff 核心

```diff
- if lsof ...; then
-   echo "Warning..." >&2
-   exit 1
- fi
+ if lsof ...; then
+   lsof -t | xargs kill
+   sleep 1
+ fi
+ # Wait up to 5s for the port to be fully released
+ for _ in {1..10}; do
+   if ! lsof ... >/dev/null 2>&1; then break; fi
+   sleep 0.5
+ done
+ if lsof ...; then
+   echo "Warning..." >&2
+   exit 1
+ fi
```

## 后续建议

1. **日志轮转：** 考虑对 `npm_start.log` 使用 `>>`（追加）而不是 `>`（覆盖），避免日志丢失。或者使用带时间戳的日志文件名。
2. **端口预留：** 在启动时增加 `SO_REUSEADDR` 选项（server/index.ts），让端口在被占时也能立即重用。
3. **健康检查：** tmux 启动后建议捕获 pane 输出，确认 node 进程是否正常退出并记录原因。
4. **重启幂等性：** stop.sh 应该保证执行完毕后端口一定是空闲的，而不是简单地检测到占用就报错退出。
