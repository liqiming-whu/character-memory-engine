#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
BGE 嵌入模块（方案 A）
=====================
基于 onnxruntime + BGE-small-zh 的文本向量生成。

- 模型：Xenova/bge-small-zh-v1.5（int8 量化，512 维）
- query 前缀：'为这个句子生成表示以用于检索相关文章：'
- 句子向量 = CLS token（输出 [0][0]）

用法：
    from embed import Embedder
    e = Embedder('/path/to/models')
    vec = e.embed('我喜欢喝奶茶', is_query=True)   # -> [512] float32
"""

import os
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

# BGE query 前缀（必须与训练一致，否则向量语义偏移）
QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章："


class Embedder:
    def __init__(self, model_dir, model_file="model_int8.onnx"):
        self.model_path = os.path.join(model_dir, model_file)
        self.tokenizer_path = os.path.join(model_dir, "tokenizer.json")
        self.tok = Tokenizer.from_file(self.tokenizer_path)
        self.sess = ort.InferenceSession(self.model_path, providers=["CPUExecutionProvider"])
        # 确认模型输入名
        self.input_names = [i.name for i in self.sess.get_inputs()]
        self.dim = self.sess.get_outputs()[0].shape[-1] or 512

    def embed(self, text, is_query=False):
        """返回 512 维 float32 向量（CLS token）。"""
        if is_query:
            text = QUERY_PREFIX + text
        enc = self.tok.encode(text)
        ids = np.array([enc.ids], dtype=np.int64)
        attn = np.ones_like(ids)
        feed = {"input_ids": ids, "attention_mask": attn}
        # BGE 三输入模型需 token_type_ids
        if "token_type_ids" in self.input_names:
            feed["token_type_ids"] = np.zeros_like(ids)
        out = self.sess.run(None, feed)[0]
        # 取 CLS token（第一个 token）向量：out[0][0] 才是 (512,)
        return out[0][0].astype(np.float32)

    def embed_batch(self, texts, is_query=False):
        """批量返回 [N, 512]。"""
        return np.stack([self.embed(t, is_query) for t in texts])


def cosine_sim(a, b):
    """余弦相似度。"""
    na = np.linalg.norm(a)
    nb = np.linalg.norm(b)
    if na == 0 or nb == 0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def cosine_sim_matrix(vec, vectors):
    """vec(512,) 与 vectors(N,512) 的余弦相似度，返回 [N]。"""
    nv = np.linalg.norm(vec)
    if nv == 0:
        return np.zeros(len(vectors))
    return (vectors @ vec) / (nv * np.linalg.norm(vectors, axis=1))


if __name__ == "__main__":
    # 自测
    import sys
    model_dir = sys.argv[1] if len(sys.argv) > 1 else "models"
    e = Embedder(model_dir)
    v1 = e.embed("我喜欢喝奶茶", is_query=True)
    v2 = e.embed("我爱喝奶茶", is_query=True)
    v3 = e.embed("我今天去了健身房", is_query=True)
    print("维度:", v1.shape)
    print("奶茶 vs 爱喝奶茶:", round(cosine_sim(v1, v2), 4))
    print("奶茶 vs 健身房:", round(cosine_sim(v1, v3), 4))
