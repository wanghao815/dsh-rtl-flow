# 打包、安装和发布

`dsh-rtl-flow` 是第三方 npm bundle。`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，配置行引用包名，入口导出 `name/inject/Config/apply`。插件通过 `ctx.systemPrompt.section` 与 `ctx.tools.register(defineTool(...))` 接入，卸载由 Cordis effect 生命周期清理。

宿主 API 基线为 DeepSeek Harness 0.2.2-rc.1、Cordis 4.1.0、Schemastery 3.19.0。共享宿主包声明 peer/dev 依赖；Schemastery 为直接运行依赖。`engines.dsh` 只声明已验证的预览版本，升级后需复验。当前发布条件见 [发布检查单](release-checklist.md)，验证范围见 [验证说明](validation.md)。

## 生成候选包

以下示例按 `package.json` 版本 0.3.0 书写；更改版本后同步实际文件名。在最终选定提交的插件仓库根目录执行：

```sh
npm ci --ignore-scripts
npm run check
npm test
npm pack
shasum -a 256 dsh-rtl-flow-0.3.0.tgz
```

`prepack` 会运行检查和测试。Verilator 缺失时 FIFO 测试明确 skip，发布记录须保留真实范围。安装包应只包含白名单文件，不含 tests、reports、node_modules、PDK、工具、主机配置和凭据；无需构建，入口为 ESM JavaScript。

从最终提交重新打包并检查文件清单、版本、可执行 CLI 和 SHA-256。源码提交、tag/release 与包内容对应，同版本号不能证明两个 tarball 内容相同。

## 干净 npm 目录检查候选

在独立临时目录安装 tarball，核对版本、实际文件、ESM 导入、CLI 可执行性与基本命令。使用 npm 安装包，避免用源码链接代替候选安装。不要安装到已有用户工程。

## 实际 Harness 安装（独立验证）

以下 `rtl-candidate` 为独立测试 profile 示例，须确认与正在验证的 dsh 进程一致：

```sh
dsh plugin --profile rtl-candidate add ./dsh-rtl-flow-0.3.0.tgz
dsh --profile rtl-candidate --dump-config
dsh --profile rtl-candidate
```

检查配置层、实际安装来源、五工具与启用/关闭/卸载生命周期。`rtl_resource_check` 须配置本次授权工作区的 `workspaceRoot`；草案和未知预算被阻塞是预期结果。模型设计验证仍需实际模型调用、合同和工具产物，宿主加载测试不代替它。

profile 安装可能提示共享 peer 未直接安装在 profile。Harness 通过 RuntimeResolution 提供共享包，须在实际宿主验证加载。开发脚本 `scripts/check-installed.js` 可用 `--install-anchor` 指向实际 dsh 的 package.json、`--home` 指向独立测试 DSH_HOME、`--profile` 指向已安装 profile，检查原生工具注册与调用；它不调用模型或启动 Web，也不随 npm 包分发。开发 overlay 可用 `rtl-flow overlay` 输出的绝对入口路径加载，与 bundle 选择一种方式。

## 发布同一份 tarball

完成发布检查单中的最终源码、基础测试、候选安装及 dry-run 后，执行正式发布。实际 Harness 新设计和 RTL-to-GDS 由使用者在发布后独立验证，未执行项保持开放。认证在本机完成；需要登录时使用 npm 的交互入口，不将密码、Token 或验证码写入聊天、插件或日志。

发布前重新核对身份、registry、名称和版本。包名或版本冲突应先核对所有权与内容，不覆盖公开版本；若调整包名，同步元数据、配置行和安装示例并重新检查打包。

```sh
npm whoami --registry=https://registry.npmjs.org/
npm view dsh-rtl-flow versions --json --registry=https://registry.npmjs.org/
npm publish ./dsh-rtl-flow-0.3.0.tgz --dry-run --access public --registry=https://registry.npmjs.org/
npm publish ./dsh-rtl-flow-0.3.0.tgz --access public --registry=https://registry.npmjs.org/
```

版本查询失败须辨别未发布、网络、认证及权限原因。记录候选 SHA-256、实际源提交、tag/release、原始发布结果及 registry 的完整性信息。dry-run 和正式发布使用已核对的同一 tarball；不要在发布时隐式从目录重新打包。

## 从公开 registry 确认安装

发布后在新的干净 npm 目录从 `https://registry.npmjs.org/` 安装精确版本，核对 registry 元数据与候选 tarball 的完整性、真实安装文件、模块导入和 CLI。工作目录链接或本地 tarball 安装不能证明公开安装通过。

实际 Harness 加载、五工具、资源检测和生命周期验证由使用者独立进行。

使用另一个干净测试 profile，从公开 npm 包安装，并核对具体版本：

```sh
dsh plugin --profile rtl-public add dsh-rtl-flow@0.3.0
dsh --profile rtl-public --dump-config
dsh --profile rtl-public
```

在独立 Harness 验证中复验加载、五工具、真实资源检测、关闭与卸载，保存实际 registry、版本及安装来源。

## 可选市场收录与接口依据

市场收录是独立步骤。需要上架时，再阅读 [市场说明](https://github.com/dsh-market/dsh-market) 与 [插件目录贡献指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)，按当时规则提交条目并核对审核、目录同步、来源识别和安装结果。

宿主接口参考：[插件起步](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.md)、[工具合同](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-tool.md)、[包与 profile 安装](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)、[配置](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/config.md)。上游会变化，兼容声明以实际固定版本复验为准。
