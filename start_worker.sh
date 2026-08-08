#!/bin/bash
# =============================================================
# CME worker 后台启动脚本（v2.4）
# 由 hiddenExec 一次性轻提交后完全脱离运行；所有重操作在此执行。
# 原子互斥：mkdir 排他（双入口/双提交只允许一个脚本真正执行）。
# =============================================================
set +e
DATA_DIR=/sdcard/Download/Operit/character_memory_engine
ROOT_DIR=/root/character_memory_engine
LOG_DIR=$DATA_DIR/logs
LAUNCH_ID=${LAUNCH_ID:-unknown}

echo "[start_worker] begin $(date '+%F %T') launchId=$LAUNCH_ID" >> $LOG_DIR/start_worker.log 2>/dev/null

# T3 探针：后台脚本进入（shell 直接写，格式与 JS/worker 一致）
_MONO=$(python3 -c 'import time; print(round(time.monotonic(), 1))' 2>/dev/null || echo 0)
echo "T3 wall=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ) mono=$_MONO launchId=$LAUNCH_ID" >> $LOG_DIR/cold_probe.log 2>/dev/null

# ---- 原子互斥：已有一个 start_worker 在跑则直接退出（single-flight 硬裁决）----
LOCK_DIR=/tmp/cme_start_worker.lock
if ! mkdir $LOCK_DIR 2>/dev/null; then
  echo "[start_worker] another instance running, exit. launchId=$LAUNCH_ID" >> $LOG_DIR/start_worker.log 2>/dev/null
  exit 0
fi
trap 'rm -rf $LOCK_DIR' EXIT

# 1) 目录准备
mkdir -p $ROOT_DIR/models $LOG_DIR 2>/dev/null

# 2) 旧 worker 在线时先 HTTP 热备（短超时，失败忽略）
python3 -c "import urllib.request,json;urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8765',data=json.dumps({'action':'sync_db'}).encode()),timeout=3)" 2>/dev/null || true

# 3) db 复制：权威在 /root，数据目录为热备副本；仅首次迁移
if [ -f $ROOT_DIR/engine.db ]; then
  cp -f $ROOT_DIR/engine.db $DATA_DIR/engine.db 2>/dev/null || true
fi
if [ ! -f $ROOT_DIR/engine.db ] && [ -f $DATA_DIR/engine.db ]; then
  cp -f $DATA_DIR/engine.db $ROOT_DIR/engine.db 2>/dev/null || true
fi

# 4) 代码/模型复制（含 start_worker.sh 自同步，确保 /root 侧脚本始终最新）
cp -f $DATA_DIR/*.py $ROOT_DIR/ 2>/dev/null || true
cp -f $DATA_DIR/start_worker.sh $ROOT_DIR/start_worker.sh 2>/dev/null || true
cp -rf $DATA_DIR/models/. $ROOT_DIR/models/ 2>/dev/null || true
if [ ! -f $ROOT_DIR/worker.py ]; then
  echo "[start_worker] NO_WORKER" >> $LOG_DIR/start_worker.log 2>/dev/null
  exit 1
fi

# 5) 杀旧 worker：pid 文件优先，/proc 遍历兜底
OLD_PID=""
if [ -f $ROOT_DIR/worker.pid ]; then OLD_PID=$(cat $ROOT_DIR/worker.pid 2>/dev/null); fi
if [ -n "$OLD_PID" ] && [ -r "/proc/$OLD_PID/cmdline" ]; then
  C=$(tr '\0' ' ' < /proc/$OLD_PID/cmdline 2>/dev/null)
  case "$C" in *worker.py*) kill $OLD_PID 2>/dev/null;; esac
fi
for p in /proc/[0-9]*; do
  if [ -r "$p/cmdline" ]; then
    c=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null)
    case "$c" in *worker.py*) kill $(basename $p) 2>/dev/null;; esac
  fi
done
sleep 1

# 6) 启动 worker（完全脱离：setsid + 三路 stdio 重定向 + LAUNCH_ID 透传）
PY=$ROOT_DIR/.venv/bin/python3.12
[ -x "$PY" ] || PY=/root/.venv/bin/python3.12
[ -x "$PY" ] || PY=/usr/bin/python3
[ -x "$PY" ] || { echo "[start_worker] NO_PYTHON" >> $LOG_DIR/start_worker.log 2>/dev/null; exit 1; }
LAUNCH_ID=$LAUNCH_ID setsid "$PY" $ROOT_DIR/worker.py --port 8765 --db $ROOT_DIR/engine.db >> $LOG_DIR/engine.log 2>&1 < /dev/null &
echo $! > $ROOT_DIR/worker.pid 2>/dev/null
echo "[start_worker] launched pid=$! launchId=$LAUNCH_ID" >> $LOG_DIR/start_worker.log 2>/dev/null
exit 0
