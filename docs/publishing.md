# 打包、安装和发布

这是独立第三方 npm bundle，包名 `dsh-rtl-flow`，不使用 DeepSeek 官方命名空间。`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，配置行引用已安装包名，导出 `name/inject/Config/apply`。插件通过 `ctx.systemPrompt.section` 与 `ctx.tools.register(defineTool(...))` 接入，卸载由 Cordis effect 生命周期清理。

固定 API 基线：DeepSeek Harness 0.2.2-rc.1、Cordis 4.1.0、Schemastery 3.19.0。共享宿主包同时声明 peer/dev 依赖；Schemastery 是直接运行依赖。`engines.dsh` 暂时锁定单个已测预览版本，不宣称兼容所有未来 0.2.x。

## 本地检查和发布包

在独立插件仓库根目录执行；如果在来源 RTL 工程中，则先进入 `dsh/`：

```sh
npm ci --ignore-scripts
npm run check
npm test
npm pack
npm publish --dry-run
```

`prepack` 运行检查和测试。Verilator 不存在时 FIFO 实测测试明确 skip；其余无需 EDA 或模型 key。正式发布者应复核输出是否存在 skip 和工程相关覆盖。`npm pack` 生成 `dsh-rtl-flow-0.2.0.tgz`，只包含发布白名单；不包含 tests、reports、node_modules、原工程资料、PDK、工具或凭据。无需 TypeScript 编译，包入口是 ESM JavaScript。

从 tarball 验证与安装目录相同的 profile 路径：

```sh
dsh plugin --profile rtl add ./dsh-rtl-flow-0.2.0.tgz
dsh --profile rtl --dump-config
dsh --profile rtl
```

检查配置层显示 dsh-rtl-flow，调用五个工具并确认启用/关闭的生命周期；rtl_resource_check 须配置实际 workspaceRoot。给模型的实际设计任务仍须使用自己的工具链、工作目录与凭据。本地插件开发可用 `rtl-flow overlay` 输出的绝对路径 `--patch`。

profile 安装可能提示缺少宿主 peer，单独运行 `pnpm peers check` 也可能报告 Cordis/tools/systemPrompt 未装在 profile 内。Harness 用自己的 RuntimeResolution 提供这些共享包；应在真实 Harness 运行时验证，不能从此提示直接判断加载失败。源码中的 `scripts/check-installed.js` 可用 `--install-anchor` 指向实际 dsh 的 package.json、`--home` 指向独立测试 DSH_HOME、`--profile` 指向已安装 profile，验证五工具注册、指导/草案/声明检查/计划并受控卸载，不调用模型或启动 Web；实际资源工具另由配置工作区的宿主集成测试覆盖。它是开发验证入口，不随 npm 包分发。

## 发布到 npm，供 dsh 安装

DeepSeek Harness 当前文档的分发路径是 npm bundle + profile 安装，并没有独立的 `dsh publish` 命令。发布者需拥有 npm 账号和该包名。若包名已被占用，先将 package.json.name 与 cordis.patch.yml 中模块名一起改为自己拥有的名称（可用 npm scope），重新检查打包；README 安装示例也同步更新。

完成本地检查后：

按用户决定，正式上传前还须实际在 dsh 中从需求完成新设计，并至少让一个小设计走完 RTL-to-GDS。0.2.0 的功能/宿主/资源测试不代替该项；完成后记录配置、模型、实际报告和未覆盖项。

```sh
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm publish --access public
```

若 registry 要求双因素验证或 trusted publishing，遵循账号的实际要求。不要将 token 写进插件文件或公开日志。插件没有绑定作者账号，没有替用户登录或上传。

发布后消费者使用：

```sh
dsh plugin --profile rtl add dsh-rtl-flow@0.2.0
dsh --profile rtl --dump-config
dsh --profile rtl
```

已选定发布身份：GitHub `wanghao815`，npm `wanghao_arch`，公开源码仓库为 `https://github.com/wanghao815/dsh-rtl-flow`，npm 包名为 `dsh-rtl-flow`。repository/homepage/bugs 已填写，GitHub 源码已公开；npm 尚未发布。正式执行前再核对账号、包名和远端状态。步骤与完成证据见 [发布检查单](release-checklist.md)。

公开仓库只包含插件源码、文档、示例、模板及独立测试；不包含来源 RTL 工程、reports、node_modules、PDK、主机配置或凭据。仓库添加 `dsh-plugin` topic。

## dsh-market 的额外收录

标准 bundle 可直接作为市场安装包，无需市场专用实现。npm 发布不会自动上架：向 `awesome-dsh-plugin/awesome-dsh-plugin` 提交一个 `data/plugins/wanghao815__dsh-rtl-flow.yml` 条目，按实际功能选择 workflow 分类并提供准确简介；不向市场应用仓库提交条目、不手改生成的 README。当前要求源码仓库创建满 1 天，CI 通过后仍需维护者审核。

目录的 npm 探针会核对 registry 中包的 repository 是否指回该 GitHub 仓库，故应在首次 npm 发布前补齐来源元数据。图标/截图可选，实际兼容范围继续由 engines.dsh 和验证证据决定。收录成功后验证目录展示、npm 来源、安装/开关/卸载和更新路径。

依据：[市场提交说明](https://github.com/dsh-market/dsh-market/blob/main/README.zh.md#提交你的插件)、[目录贡献指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)、[npm 来源探针](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/scripts/probe-npm.mjs)。这些规则于 2026-11-09 核对，正式提交前复核变化。

## 上游依据

- [插件起步](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.md)：apply/inject 与绝对路径 overlay。
- [工具作者合同](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-tool.md)：defineTool、canonical value、signal 与效果生命周期。
- [包与 profile 安装](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)：dsh.bundle、engines.dsh、peer/dev 共享和 plugin add。
- [插件配置](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/config.md)：Schemastery Config 与配置重载。
- [仓库说明](https://github.com/deepseek-ai/deepseek-harness)：预览状态、运行方式和 dsh-plugin topic。

以上在 2026-11-08 查阅，并以固定版本真实 npm 包执行本地 API 测试；网页 master 会继续变化，未来升级需重新核对。
