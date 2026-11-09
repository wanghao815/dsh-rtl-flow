# 0.1.0 本地验证

日期：2026-11-08。环境：macOS arm64，Node 26.4.0；固定 Harness/Cordis/Schemastery 为 0.2.2-rc.1 / 4.1.0 / 3.19.0。原工程保持 D49 暂停。

| 范围 | 实际结果 |
| --- | --- |
| 包结构和文档 | bundle/overlay、导出/资源、peer/dev 依赖、四类配置、模板替换和本地链接检查通过 |
| 指导文件 | skill-creator quick_validate 通过；验证器依赖只装入临时目录 |
| 功能测试 | 13 项通过，0 失败，0 skip；包含关口矩阵、草案/暂停、缺证据、错误状态、负例退出、重复项、检查点/发布版本绑定、摘要/源覆盖和 symlink 越界、覆盖保护 |
| 真实 Harness API | Cordis + SystemPrompt + ToolsService + 原生 Native 执行器，三个工具 canonical value、schema 错误、输入预算、取消、关闭/重载和卸载清理均通过 |
| 新项目 CLI | FIFO 配置创建 14 个草案文件；缺执行证据的 audit 按预期退出 1，不将 scaffold 记为设计通过 |
| 非阵列 RTL 夹具 | Verilator 5.054，深度 3 ready/valid FIFO 的 full、wrap、同时出入、回压、数据顺序、固定随机输入及复位通过；故意翻转写数据被独立队列 scoreboard 的 data/order mismatch 检出 |
| 完整 dsh 安装路径 | 临时目录安装 0.2.2-rc.1，独立临时 profile 执行 plugin add 成功；dump-config 退出 0，出现 dsh-rtl-flow bundle 层及配置行 |
| 发布包宿主解析 | tarball 安装后的 profile 以实际 RuntimeResolution + PluginPackages 提供共享 peers，原生工具加载与调用通过；pnpm 静态 peer 提示没有被当作宿主失败 |

发布 tarball 与 dry-run 的最终结果、摘要和文件清单在源码交付目录 `reports/` 记录。打包白名单排除原工程文件、tests、reports、node_modules、PDK、主机配置和凭据。包不要求构建步骤。

## 尝试与修复

公开 GitHub 直接 clone 与 raw 下载出现连接无进展/SSL 超时，停止本次下载后，通过官方仓库网页读取接口和文档，实际验证使用固定版本 npm 包。未将网页版本号当作兼容测试通过。

最初的宿主 smoke 清理调用误用了不存在的 ctx.dispose，已按 Cordis 真实 fiber.dispose 清理。首次 prompt assembly 测试缺少原生执行器，后补齐固定版本 Native 插件；批调用入口与 ToolCallBlock 随后按已安装声明修正为 tools.execute 和原生 JSON arguments。修复后全部集成测试通过。初次指导文件校验缺 PyYAML，临时目录补件后通过，原 Python 环境未修改。

上述属于本插件验证入口修复，未改变原项目 RTL、数值、时钟或物理检查点。原始本地测试日志和最终 scope 摘要在 reports/，根目录能力报告另记 DSH-01 的结果。

首次 npm pack 的 prepack 检查和 13 项测试全部通过，随后写默认 npm 缓存遇到 EPERM。改用临时目录缓存打包，保留首次日志；未按 npm 的泛化提示修改用户缓存所有权或权限。包名只读查询返回公开 registry E404，表示本次未发现公开包，不保证未来名称可注册或账号拥有发布权。

一次可选 Web 帮助探针在临时 profile 中没有返回，已受控结束；最终安装验证采用无需 Web/模型的真实 profile 解析与原生工具调用，不声称 Web UI 启动验证通过。发布 dry-run 发现 bin 路径 `./` 触发 npm 规范化提示，改为 canonical `bin/rtl-flow.js` 后最终 tarball dry-run 退出 0，CLI 文件保持可执行。

## 未覆盖与依赖限制

没有用模型 API 在 Harness 中从自然语言生成并验收一个新 IP，没有将上述 FIFO 夹具当作任意 RTL 生成正确性证明；没有重跑来源项目 EDA、任意新设计完整 RTL-to-GDS、真实宏签核或 FPGA/商业后端。实际质量仍取决于当前模型、合同、验证和可用工具。

安装时 npm audit 报告固定 Harness 依赖传递使用 Zod 4.4.3，关联 GHSA-mrhx-c7xc-m3w5（过大约束集合验证可能耗尽内存）；加入 Native 测试依赖后的扫描显示 9 个 high 依赖条目，源于同一传递风险链。未执行会改变宿主兼容性的自动升级/强制修复。插件工具限制输入字节数，但这不等于消除宿主依赖问题。升级兼容版本或由宿主维护者处理后需复验。

未向 npm 或任何公开插件索引上传，也未修改用户现有 dsh profile。包名、账号权限和正式公开仓库由发布者确定。
