# ToolPkg 开发说明

本项目为 Operit ToolPkg 插件。

开发原则：
- 优先参考 docs/reference 官方文档。
- Operit 最终权威来源为 https://github.com/AAswordman/Operit 。
- `D:\Operit` 是本地权威 Git 仓库；过时时按项目代理规则执行 `git pull`。
- API 判断依次核对上游 `docs/`、`examples/types/` 和实际运行时实现；冲突时以上游最新源码为准。
- 修改前确认 ToolPkg API。
- 保持 manifest 兼容。
- 使用 Operit Memory API，不创建第二套数据库。

流程：

源码
↓
修改
↓
构建 ToolPkg
↓
生成 .toolpkg
↓
Operit 导入测试

重点：
先确认官方 ToolPkg 构建流程，再进行功能开发。
