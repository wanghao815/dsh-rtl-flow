# schema v2：证据、原始报告和同源检查点

0.2.0 将设计身份、技术结果和交付结果分开。`rtl-flow.json` 中的 top、kind、target、平台、特性、parameters、defines 和合同路径形成稳定 design_sha256。生命周期、工作入口、运行预算和交付决定不属于 DUT 身份；更新这些运行信息不会使未变设计失效。合同、源码、工具和物理材料另以实际文件 SHA-256 绑定。

## 当前证据索引

`reports/rtl-flow/evidence.json` 为 `{ "schema_version": 2, "records": [] }`。每个 gate/check/platform 只有一项当前记录，历史与首次失败放在 attempts 目录。

| 字段 | 约定 |
| --- | --- |
| id / gate / check / platform | 唯一记录与 requirements 中真实存在的检查项 |
| scope / summary / limitations | 验证对象、原始结论和限制；不能以执行完成扩大范围 |
| status | pass/fail/blocked/timeout/unsupported/not_run/not_applicable/aborted |
| design_sha256 | 当前配置指纹；top、参数或特性变化使旧 pass 失效 |
| checkpoint | 可读 ID，单独不能证明同版 |
| command / exit_code / expected_exit_code | 实际 argv 与原生结果；130/137/143 等中止不接受为 pass |
| acceptance | 预声明 criterion 与 passed，仍需实际文件/报告核对 |
| inputs / artifacts | `{path,sha256}` 数组；路径在项目内，摘要为 64 位小写十六进制字符串 |
| source_manifest | G3–G7 每行一个相对 RTL 路径；清单、全部源码及当前合同须在 inputs 中 |
| reports | 非人工评审项的原始报告解析配置数组，报告必须在 artifacts 中有摘要 |
| checkpoint_manifest / checkpoint_sha256 | 物理检查引用真实清单及其文件 SHA-256 |
| release_checkpoints | ASIC release 按平台引用最终物理清单摘要，而非任意名称 |

spec_review/release/archive 可以由有文件依据的人工评审验收；实际仿真、结构、形式和物理技术项必须给出报告解析入口。错误输入返回结构化问题；无效或失效证据使自身关口和下游阻塞，并产生 next，不能出现全部关口通过却全局失败的矛盾。

## 自动捕获物理基线

先准备 checkpoint spec，明确 id、platform、source_manifest 和 `roles:{role:[项目相对路径]}`，再运行 `rtl-flow capture <root> --config <spec>`。工具读取实际文件，自动捕获所有合同、源码清单、RTL、项目 parameters/defines 及声明物理角色，合并相同路径的 roles，输出 manifest 草案。通过正常文件工具保存到项目后，用 `rtl-flow hash` 取得它的摘要。

manifest 包含 schema_version=2、id、platform、design_sha256、source_manifest、parameters、defines 和 `inputs:[{path,sha256,roles:[...]}]`。每条物理证据 inputs 必须包含 manifest 及其完整输入闭包。G6/G7 必须共享同一份实际 manifest 摘要，release 逐平台绑定它。

按检查要求角色：STA/leaf_timing 要网表、SDC、寄生、Liberty、RC 规则、技术文件和数据库；DRC 要版图、规则和技术；LVS 要版图、参考网表、规则和技术；天线要数据库、规则、端点模型和技术；电源要数据库、网表、Liberty、负载模型和技术。实现阶段另需版图。含宏平台还必须绑定宏模型及完整视图清单；视图可以是项目内带摘要的依赖锁与项目内真实文件，审计不跟随越出项目的链接。

工具不能自动发现未声明的外部 include/库依赖；工程入口须将真实闭包写入锁定清单，并通过实际工具调用验证。清单一致也不能代替适用等价和原生物理检查。

## 原始报告解析

`reports` 每项给出 path、parser 及必要配置。支持：

- cocotb：读取全部原生 TESTS/PASS/FAIL/SKIP 汇总，逐份要求非空、零失败/跳过、计数一致；较早失败不能被最后一份成功覆盖。
- yosys-check：读取实际 check 的 problems 与 ERROR，不把版本/help 当结构检查。
- sby：读取 DONE 的 PASS/FAIL/UNKNOWN/ERROR/TIMEOUT，未知和超时不通过。
- netgen：要求唯一匹配并排除 mismatch/property errors，模型/器件覆盖另列。
- marker：只用于项目明确规定的非物理工具精确成功行，不能认证 STA/DRC/LVS 等。
- json-metrics：用显式 JSON Pointer 从真实工具/导出器报告读取指标，执行检查类型对应的固定判据。未知/缺失/错误类型阻塞，不从模型补值。

json-metrics 示例：`{"path":"reports/sta.json","parser":"json-metrics","fields":{"setup_wns_ns":"/setup/wns_ns","hold_wns_ns":"/hold/wns_ns"}}`。这只是指针示例，不能据两个字段完成 STA；完整要求如下。

| 检查 | 必需的原生指标 |
| --- | --- |
| sta / leaf_timing | setup_wns_ns、hold_wns_ns 非负；setup_tns_ns、hold_tns_ns、unconstrained_endpoints、missing_parasitic_nets、cap_violations、slew_violations 为 0；annotated_nets 大于 0 |
| drc / antenna | violations=0 且 checks_executed>0；不能将无规则/无模型的零项当通过 |
| lvs | matched=true，devices/ports>0；抽象、排除器件和内部范围仍须人工复核 |
| power | vdd_shorts/vss_shorts/unconnected_power_pins=0，solved_rails=2，ir_drop_v 不超过明确的 ir_limit_v |
| implementation / physical_smoke | unrouted_nets/unplaced_instances=0，instances/routed_nets>0 |
| 其他技术项 | checks_executed>0，failures=0，另符合对应合同 |

JSON 适配要求真实工具/脚本导出这些可对应指标，保留导出器、原报告和版本；不表示所有 EDA 工具原生具有同名字段。`rtl-flow parse` 可先验证适配。若当前工具只输出不支持的格式，保持 unsupported 并新增有实物正反例的解析适配，不重写报告冒充成功。

解析器须匹配检查类型：STA/leaf_timing、DRC、天线、电源及实现使用 json-metrics；LVS 使用 netgen 或 json-metrics；formal 使用 sby 或 json-metrics；leaf_structure 使用 yosys-check 或 json-metrics。其他功能技术项支持 cocotb/marker/json-metrics。toolchain 可组合上述工具探针。Yosys 零问题不能代替 STA，测试通过不能代替物理检查。

## 结果口径

`rtl_check_evidence` 返回 declarations-only；CLI audit 返回 files-and-native-reports，并记录 parsed_reports 的实际指标和原因。摘要缺失、串版、报告失败或异常字段都会阻止相应技术通过。

输出分 technical_ok、delivery_ok、outcome 和 open_items。full_verified 要完整适用技术项通过；scoped_delivery 按有决定依据的排除项交付，原检查仍显示 unsupported/fail/not_run 等；experiment_closed 只完成 archive，所有未通过技术项保留。paused 始终不给新任务恢复授权。CLI 零退出只表示指定交付口径满足，不能直接用来宣布完整验收。
