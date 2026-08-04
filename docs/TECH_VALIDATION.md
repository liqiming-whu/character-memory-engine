# 技术验证记录（P0 Spike）

> 更新时间：2026-08-04
> 状态：✅ 全链路技术验证通过

## 结论

Character Memory Engine 的完整技术栈（SQLite + sqlite-vec + onnxruntime + BGE-small-zh）在 Operit 内置 proot Ubuntu 24 环境下**全部可用**。

## 验证明细

### 运行环境

- Operit 终端：`terminal.hiddenExec` 可用（`Tools.System.terminal`）
- 系统：proot 下的 Ubuntu 24（`SystemToolPrompts.kt` 确认 `linux` 环境为 proot Ubuntu 24）
- Python：3.12（venv 于 `/root/.venv`）
- 注意：uv 在 proot 下有 hardlink/copy bug，改用 `python3 -m venv` + `pip` 安装成功

### 组件验证

| 组件 | 结果 | 备注 |
|---|---|---|
| onnxruntime 1.28.0 | ✅ | `providers: ['AzureExecutionProvider','CPUExecutionProvider']`；GPU 设备发现失败是 proot 无 DRM 权限，不影响 CPU 推理 |
| sqlite-vec 0.1.9 | ✅ | 有 `manylinux_2_17_aarch64` wheel，`pip install` 成功 |
| BGE-small-zh int8 | ✅ | 从 `Xenova/bge-small-zh-v1.5` 下载 `onnx/model_int8.onnx`（23.9MB），位于 HF 缓存 |
| tokenizer | ✅ | `tokenizers.Tokenizer.from_file` 可用 |

### 模型关键信息

- 模型仓库：`Xenova/bge-small-zh-v1.5`（社区 ONNX 导出版；`BAAI/bge-small-zh-v1.5` 官方仓库无 onnx 导出）
- 模型文件：`onnx/model_int8.onnx`（int8 量化，23.9MB，移动端友好）
- 辅助文件：`tokenizer.json`、`config.json`
- 下载命令：`hf_hub_download('Xenova/bge-small-zh-v1.5', 'onnx/model_int8.onnx')`
- 设备缓存路径：`/root/.cache/huggingface/hub/models--Xenova--bge-small-zh-v1.5/snapshots/<commit>/`

### ONNX 模型输入/输出

- **输入**（3 个，必须全给）：
  - `input_ids`: int64 (1, seq_len)
  - `attention_mask`: int64 (1, seq_len)
  - `token_type_ids`: int64 (1, seq_len)（单句全 0）
- **输出**：`(1, seq_len, 512)` 每个 token 的隐藏状态
- **句子向量 = CLS token**（`out[0][0]`，即第一个 token 的 512 维向量），不是整个序列

### BGE 文本前缀

- **query**：`为这个句子生成表示以用于检索相关文章：` + 查询文本
- **passage**（存储的记忆）：直接用原文（或同前缀，需按版本确认）

### 语义相似度验证

| 对比 | 余弦相似度 | 结论 |
|---|---|---|
| 奶茶 vs 爱喝奶茶 | 0.9524 | 语义相同 → 高 |
| 奶茶 vs 健身房 | 0.4659 | 语义无关 → 低 |

- 语义去重阈值建议：相似度 ≥ 0.90 判定为重复（可配置）
- 检索 top-K 取相似度最高的前 N 条

## 部署注意

1. **venv 路径**：worker 脚本需用 `/root/.venv/bin/python3` 或激活 venv 后运行
2. **模型路径**：首次运行 worker 时若模型缺失，由 worker 自动 `hf_hub_download`（需代理）或从打包资源释放
3. **token_type_ids**：必须提供，否则 onnxruntime 报 `Required inputs (['token_type_ids']) are missing`
4. **UV 不可用**：proot 下 uv 的 hardlink/copy 均失败，统一用 pip

## 遗留风险

- 模型文件（23.9MB）首次获取需网络（代理）；后续可考虑随 ToolPkg 资源打包
- int8 量化精度足够语义去重/检索，但若需更高精度可评估 `model.onnx`（fp32，约 95MB）
- GPU 不可用（proot 无 DRM），仅 CPU 推理，单次嵌入延迟需实测（预计几十~几百 ms/条）
