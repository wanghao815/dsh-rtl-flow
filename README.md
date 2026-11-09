# RTL design flow for DeepSeek Harness

`dsh-rtl-flow` 是一个通用 RTL 工程插件，覆盖架构、RTL、验证、综合、物理实现、交付和恢复。0.2.0 根据用户确认的 Q2–Q6，加入五种工作入口、按特性组合的指导、真实文件/报告审计、设备资源检测和分离的交付状态。

**先读 [核心流程全文](docs/core-workflow.md)。** 它是主流程的唯一正文，`rtl_guide(workflow)` 直接读取同一文件。完整模型设计闭环的实测由用户留作发布前执行，本次更新不声称该项已通过。

## 支持的工作入口

| 入口 | 行为 |
| --- | --- |
| new 新建 | 建立当前项目自己的合同与工具最小集，逐级实现 |
| adopt 接手 | 审计已有源码、约束、测试和报告，预览缺失管理文件，保留原文与原约定 |
| modify 修改/调试 | 显式记录影响类别，复用有效先决条件，选择受影响检查 |
| eco 物理优化 | 保留原逻辑/约束/失败源，做适用等价、时序与物理复验 |
| resume 恢复 | 核对最新决定、进程与最后完整检查点；不会自动清除 paused |

已有项目不必重新跑 G0–G8。`work` 根据磁盘审计与显式影响给出 reuse/invalidate/execute；这是一份计划，执行仍须满足技术依赖和授权。`adopt` 只预览缺失文件，不覆盖既有文件。已有合同路径可用 project options 的 `contracts` 映射，不强迫迁移原目录。`init` 专用于新项目。

## 指导按特性组合

stage 主流程与 arithmetic、stream、protocol、multiclock、memory、macros、formal 七个专题共同工作。每个专题说明进入条件、输入、处理、产物、判据和失败诊断。比如带反压、跨时钟的算术模块同时启用 arithmetic/stream/multiclock；一个名称不能代替完整特性清单。

模块名称只提供可编辑的初始建议。新项目须明确实际特性，不继承来源案例的阵列、数制、流水、容量、频率或工艺。工具/平台按项目选择；当前后端指导以开源 ASIC 流程为参考，FPGA 与商业工具需要对应项目适配。

## 安装与配置

已测运行基线：Node.js ≥24.9，DeepSeek Harness **0.2.2-rc.1**。DSH 是预览版，升级后重新验证。插件版本 0.2.0 与 DSH 版本彼此独立。

以下命令在独立插件仓库根目录（含 package.json）执行。如果仍在来源 RTL 工程内，先进入其 `dsh/` 子目录。

```sh
npm ci --ignore-scripts
npm run check
npm test
```

从独立插件仓库根目录安装到测试 profile：

```sh
dsh plugin --profile rtl add .
dsh --profile rtl --dump-config
dsh --profile rtl
```

未全局安装 dsh，可用 `npx --yes @deepseek-ai/dsh@0.2.2-rc.1` 替代命令中的 dsh。开发 overlay 用 `node bin/rtl-flow.js overlay` 输出绝对入口路径，选择 bundle 或 overlay 中一种加载方式。

正式发布 npm 后，可直接安装 `dsh-rtl-flow@0.2.0`。当前是否已公开发布及来源仓库是否已创建，以实际 registry/GitHub 状态为准；写入元数据不代表已上传。发布步骤与实测条件见 [发布检查单](docs/release-checklist.md)。

插件沿用宿主模型、文件/终端权限及取消机制，不包含 API key。配置字段：`enabled`、`promptOrder`、`maxInputBytes`，以及可选 `workspaceRoot`。要使用原生资源检测工具，将 workspaceRoot 设为当前已授权项目的绝对路径；不配置时用宿主终端执行 CLI resources。切换项目须同步更新该字段。

## 模型工具

| 工具 | 功能与边界 |
| --- | --- |
| rtl_guide | 返回核心流程、阶段或特性专题 |
| rtl_scaffold | 返回新项目文档/配置草案，不生成通过证据，也不直接写文件 |
| rtl_plan_work | 按入口、变更影响和审计结果选择复用/失效/执行范围与专题 |
| rtl_check_evidence | 结构、配置指纹、依赖及交付状态检查；标记 declarations-only |
| rtl_resource_check | 对 workspaceRoot 指定项目实际检测内存/磁盘、已有耗时、剩余任务和预算；不启动进程 |

RTL、testbench 和流程由宿主模型结合项目合同生成。工具报告的真实读取、原生指标解析和文件摘要核对由 CLI audit 完成；模型工具的 JSON 声明检查不能替代它。

## CLI 用法

在含 package.json 的插件根目录：

```sh
node bin/rtl-flow.js plan --config examples/fifo.json
node bin/rtl-flow.js init /tmp/my-fifo --config examples/fifo.json
node bin/rtl-flow.js adopt /path/to/existing --config examples/fifo.json
node bin/rtl-flow.js work /path/to/project --entry modify --impact rtl,control
node bin/rtl-flow.js topics /path/to/project
node bin/rtl-flow.js audit /path/to/project
node bin/rtl-flow.js resources /path/to/project
node bin/rtl-flow.js run /path/to/project --task smoke
```

`adopt` 的配置需描述真实旧项目；上面 FIFO 文件仅示范命令。新建草案无执行证据，audit 按预期失败；预算和剩余任务未填写时 resources 也会阻塞。

`capture <project> --config <checkpoint-spec>` 从真实文件自动采集合同、源码、参数及各物理角色的摘要，向 stdout 输出检查点清单；`parse` 读取单份原始报告；`hash` 生成摘要。详见 [证据规范](docs/evidence.md)。

CLI 退出码：0=本操作指定范围满足，1=检查/预检未满足或原生任务失败/中止，2=输入/基础执行错误，130=CLI 中断。`audit` 还必须查看 technical_ok、delivery_ok 与 outcome，不能只看退出码。

## 资源预算与受控运行

`config/resource-plan.json` 列出全部剩余任务、依赖、明确 argv、重任务标记和时间/内存/磁盘估算。历史已耗时间从原生 run ledger 加上不重叠的 prior_wall_minutes 统计；已用磁盘范围须注明。估算来自实际探针或有理由的保守上界，未知量阻止执行。

`resources` 用实际设备内存、有效限制、当前可用内存和实际工作文件系统可用空间，与完整剩余计划及预算比较。macOS 可用内存采用保守值，不把可回收缓存直接当作空闲。共享文件系统的空间变化保守计入，避免乐观归因。

显式 `run --task` 每次只执行一个前台任务，原生 argv 不经 shell，拒绝重复/未满足执行依赖的任务。任务及其依赖摘要改变后，旧完成记录失效。它持有项目锁，记录原生退出、日志、墙钟和采样进程树 RSS，并检查设备空间、预算与计划变化；启动前和退出后核对实际文件占用，补足短任务磁盘计量。超限或监测不可用时受控结束本次创建的进程组；无自动重试、隐藏调度或按名字批量结束进程。此运行器仅支持 macOS/Linux，宿主 jobs 可以监督其前台生命周期。

短于首次采样间隔的任务会标注“未采样”，不伪造峰值。按采样检测无法保证捕获瞬时峰值；足够保守的前置估算、余量和串行启动仍必需。执行完成只表示原生命令按预期退出，硬件验收另由原始报告和技术审计决定。详见 [资源配置和操作](docs/resources.md)。

## 交付与暂停

项目 state 为 active/paused/archived；delivery.intent 为 full/scoped/closeout。full 要求全部适用技术项通过；scoped 需要明确决定和逐项范围说明，保留每项原始状态；closeout 允许实验归档完成，同时保留未通过的技术项。

因此 `delivery_ok=true` 不必意味着 `technical_ok=true`。原始失败不会因范围排除或收尾消失，open_items 必须随交付保留。暂停不被 resume 入口解除，恢复依据新的明确决定。

明确 closeout 决定下，paused 项目可通过受控入口执行标为 purpose=closeout 的归档/清单核对任务；剩余设计任务仍阻塞，archived 不启动新任务。

## 版本与验证

0.2.0 使用 schema_version=2。`migrate <project>` 只输出 v1→v2 草案，保留工作区；必须重新核对特性、预算和旧证据的来源绑定，禁止自动把 v1 报告变成已认证 v2 报告。原 0.1.0 包和证据仍保留。

四类配置见 [FIFO](examples/fifo.json)、[APB](examples/apb-registers.json)、[DSP](examples/dsp-mac.json)、[真实宏存储](examples/memory-subsystem.json)。更多说明：[核心流程](docs/core-workflow.md)、[证据](docs/evidence.md)、[资源](docs/resources.md)、[来源](docs/source-map.md)、[发布](docs/publishing.md)、[验证](docs/validation.md)。原始本地报告保存在 reports/，不随 npm 包发布。

## Model Experience 与限制

插件注入稳定的流程入口提示和五个工具 schema，详细主流程/专题按需加载。工具注册/提示随 Cordis 卸载和配置重载清理。它没有全局拦截任意宿主终端命令的权限策略；Agent 必须依核心流程在重任务前使用预检/受控入口，绕过 CLI 的命令不受本运行器监测。

原生报告只对文档列出的格式自动解析，未知格式保持开放。摘要保证一致性，不证明日志不可篡改或原始工具本身正确。规则/模型覆盖、抽象和工程适用性仍需复核。没有将本轮单元/宿主测试当成真实模型新设计、全流程 PDK 或制造签核验证。

固定 Harness 依赖的已报告风险及实际兼容范围见验证说明。包可本地安装和打包；正式公开发布前，完成约定实测并复核最终 tarball。原始本地运行记录、依赖目录、主机配置和凭据不进入独立公开源码仓库。
