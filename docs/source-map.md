# 来源提炼与跨设计边界

本插件依据 2026-11-08 的 Tile-Based Result-Stationary Tensor Core 项目资料提炼，保留工程方法，不拷贝其 RTL、测试数据、工艺视图、主机路径或物理大文件。目录可单独分发，无需原工程。源文件逐份摘要保存在本地 `reports/source-manifest.json`。

用户称 `agents_ability_report.md` 的文件，实际为根目录与 key_guidance 中的 `agent_ability_report.md`。key_guidance 的四份管理文档是根文件快照，按相同内容识别，不重复当成两次独立工程证据。

| 原资料 | 提炼的机制 | 插件落点 |
| --- | --- | --- |
| AGENTS.md、TODO.md | 规格/实现/验证分开，任务依赖和准入，按实际范围交付 | workflow、project 模板、G0–G8 |
| key_milestone.md | 确认/候选/推导，决定原因、替代关系和阻塞生命周期 | architecture、key_milestone 模板 |
| agent_ability_report.md | 首次失败与复验、人工介入、计量缺失和泛化层次 | operations、能力报告模板、验证报告 |
| key_guidance/agent_guidance.md | 资源预估、最小探针、同版验收、暂停和归档 | workflow、physical、operations |
| docs/numeric_formats.md、golden.md、t24_numeric_acceptance.md | 明确编码/舍入图、独立 reference、运行前判域、严格例及反向检错 | verification、numeric_contract 模板 |
| docs/cycle_contract.md、result_writeback.md | pre/post、寄存器所有权、接受/提交/副作用/完成的精确沿 | architecture、cycle_contract 模板 |
| docs/element_review.md、element_design_review.md、element_microarchitecture.md | 候选取舍、资源/位宽/反馈与来源依据，不把纸面冻结当时序通过 | architecture、rtl、spec 模板 |
| docs/element_implementation_plan.md、element_validation.md | 真实 leaf、同一核心逐级复用、结构与早期布线时序 | rtl、verification、physical |
| docs/control_validation.md、reference_cases.md | 控制 token 与真实功能分开、固定 seed、故障注入与外部输出检查 | verification、G2/G3/G5 |
| docs/sram_layout.md、sram22_integration.md | 布局、掩码、延迟、三种容量口径、真实宏同镜像回放 | toolchain、rtl、physical、macro_replay |
| docs/environment.md、toolchain.md 与 config 工具/规则/依赖锁 | 检查实际调用能力、正反例、小流程、新终端、材料版本追溯 | toolchain、toolchain-lock 模板 |
| docs/rtl_handoff.md、stage9_handoff.md | 最新暂停决定覆盖旧接续队列，交接写明确入口和开放范围 | operations、handoff 模板 |
| config/element-contract.json、reference-cases.json | 配置作为机器可读合同，输入/判据/结果分离 | rtl-flow.json、evidence 索引 |
| constraints/*/6_final.sdc | 约束绑定检查点，ECO 后按原合同复验 | physical；原 SDC 不拷贝 |

## 关键失败如何转为通用规则

| 来源事件 | 经验证的观察 | 本插件采用的方法与边界 |
| --- | --- | --- |
| AAR-003/004/006/008 | 返回码/判定、Tcl 能力、SV 支持和报告入口存在实际偏差 | 实际调用链、正反例、提前综合与判据字段，不能只验版本/零退出 |
| AAR-007/013 | 候选路径误带入假设，容差可能放过清零 | 运算图先行、按真实项数推导、严格规范例；不复用原数值常数 |
| AAR-010/011/014/015 | 图件曾补交，采样沿与共享寄存器可偏一拍 | 波形/架构/后端图进入交付，逐沿合同，单一状态/寄存器归属 |
| AAR-017 与 G8 | 行为通过仍需核对实际宏别名、端口和同镜像数据 | 真宏接线/掩码/时序和实际输出回放；bank 数量由新平台重算 |
| AAR-023、D48/D49 | 顶层硬宏数量不能代表展开后的物理验收规模 | 展开规模与多阶段资源探针、首图/收敛分估、预算触发处理 |
| AAR-070、079、083–089 | 受限 LVS、规则改写、零天线项可能覆盖不足 | 正反例和实物资格，原报告保留，限定规则/器件/边界范围 |
| AAR-084/092 | 包装 trap 曾将实际中止记录为零 | 原生退出/包装状态/判据分开，暂停先冻结调度再退出，保留最后完整源 |

## 不推广的来源约束

不内置阵列行列、PE/element 层次、result stationary、特定数制/scale、两级算术、共享 Q0、单任务、T+18、固定写回拍数、容量/bank 数、100/25 MHz、指定 Mac/Miniconda/工艺路线或强制换窗口节点。新项目分别确认这些选择。浮点预算方法只是一个可选分支，控制/协议不要求浮点模型。

本次跨设计验证包括多种项目配置和一个非阵列 FIFO 实测夹具，未对 CPU、总线、DSP、存储和任意 IP 完成全流程交叉验证。来源项目已按 D49 暂停；提炼插件不构成恢复原工程的指令。

## 0.2.0 用户评审决定

2026-11-09 用户确认 Q2–Q6：五种入口及有效先决条件复用、主流程与可组合特性专题、实际文件/原始报告审计、已有耗时与剩余工作及设备资源预算、技术结果与范围交付/实验收尾分开。相应规则集中在 [核心流程](core-workflow.md)，格式与执行边界分别见 [证据](evidence.md) 和 [资源](resources.md)。Q1 的真实模型新设计与小设计 RTL-to-GDS 验证，由用户保留为正式发布前执行。
