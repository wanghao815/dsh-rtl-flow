# 独立仓库与 npm 发布检查单

目标：GitHub `wanghao815/dsh-rtl-flow`，npm `dsh-rtl-flow`，发布版本 0.2.0，已测 DSH 0.2.2-rc.1。下面是发布流程；完成状态以真实命令、外部页面和报告为准。

## 已完成的发布准备

- 用户选择 npm 分发，并同意仅将插件内容建立为独立公开仓库。
- 本地已核实 GitHub 用户 wanghao815、npm 用户 wanghao_arch；身份检查不代表包名所有权或将来的发布必然成功。
- 2026-11-09 registry 查询返回 dsh-rtl-flow E404，尚未发布。GitHub 公开源码仓库已按用户确认创建；源码推送及 npm 状态以实际提交和 registry 为准。
- package.json 已填写目标 repository、homepage、bugs 和作者；安装说明适配独立仓库根目录。
- 0.2.0 已有 34 项功能测试、真实资源负例、独立 DSH profile 和发布 dry-run 证据，范围见 [验证说明](validation.md)。

## npm 正式发布前

- [ ] 在 dsh 中由模型从新需求完成架构、RTL 和验证；记录模型、配置、合同、命令及原始报告。
- [ ] 至少一个小设计完成 RTL-to-GDS；明确时序、物理检查范围和开放项。
- [ ] 按上述实测修订实际能力声明、版本与兼容范围，不用固定 FIFO 或合成指标夹具代替。
- [ ] 对最终待发布内容执行检查、必要测试、pack 和 tarball dry-run，核对摘要、文件白名单及可执行 CLI。

## GitHub 源码公开与 npm 发布

- [ ] 复核待推送清单只包含独立插件资料，不含来源 RTL 工程、工艺材料、主机路径记录、缓存或凭据。
- [ ] 创建 GitHub 公开仓库、推送经检查的源码，添加 dsh-plugin topic；正式 release/tag 对应实际提交。
- [ ] 复核 npm 登录身份、包名权限、发布版本和 registry，按实际要求完成发布认证。
- [ ] 发布已核对摘要的 tarball，记录包版本、完整性信息及 npm 页面。
- [ ] 从公开 registry 安装到干净 DSH profile，复验配置、五工具、资源检测和卸载；不以本地安装结果替代。

## dsh-market 收录

- [ ] GitHub 仓库创建满当前规则要求的 1 天，项目代码可检查且描述准确。
- [ ] 向 awesome-dsh-plugin/awesome-dsh-plugin 提交自己的 YAML 条目，不手改生成 README。
- [ ] 确认 npm 包的 repository 与条目仓库一致，等待 CI、维护者审核和目录同步。
- [ ] 收录后检查市场卡片、兼容范围、npm 安装来源及安装/更新/卸载路径。

源码仓库、npm 和市场分别记录结果。按用户确认的顺序，先创建并公开独立 GitHub 源码仓库，再正式发布 npm。GitHub 源码公开用于检查和试用，不表示已完成真实设计闭环。元数据准备、身份登录、dry-run 和目录 PR 都不等于 npm 发布成功；真实项目实测条件尚未满足时，停止 npm 正式发布及市场提交。
