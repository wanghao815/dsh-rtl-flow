# OpenROAD/ORFS 环境探测、获取与锁定

插件仅分发获取方法、官方链接、配置和检查代码。EDA 工具、镜像、PDK、库及本地运行报告不进入 npm 包。安装 npm 包或启用插件不触发工具/平台下载；只有明确选择 ORFS 并执行 `env --action prepare` 才会获取缺失环境。

## 先选择，再准备

先确认项目交付是否需要 ASIC 后端，以及用户选择的是 ORFS、现有商业流程还是其他工具。`env inspect` 在没有 ORFS 配置时返回 `not_selected`，不自动替用户更换工具。

当前支持两条路线：

| 路线 | 处理与边界 |
| --- | --- |
| native | 复用用户已有的 OpenROAD、Yosys、KLayout、Python3、GNU Make 与 ORFS 根目录，核对 Nangate45 平台材料；不自动编译或安装系统软件 |
| docker | 优先复用本地官方 `openroad/orfs` 镜像；缺失时拉取解析为固定 digest 的镜像，配套 ORFS、工具和平台来自同一镜像 |

`mode=auto` 只在用户已通过配置选择 ORFS 的前提下优先复用完整 native 环境，否则规划 Docker。版本输出和文件存在属于探测，最小可用性检查是另一步。

首个自动化平台为 **Nangate45**，包含 ORFS 配套的 FreePDK45/Nangate 库材料。它用于流程研究与实验，不代表代工厂制造签核。其他工艺和宏需要独立适配与材料，不能只更换平台名字。

## 获取方法与官方链接

- [ORFS 源码与安装路线](https://github.com/The-OpenROAD-Project/OpenROAD-flow-scripts)
- [官方 Docker 使用方法](https://openroad-flow-scripts.readthedocs.io/en/latest/user/DockerShell.html)
- [预编译工具说明](https://openroad-flow-scripts.readthedocs.io/en/latest/user/BuildWithPrebuilt.html)
- [本地编译说明](https://openroad-flow-scripts.readthedocs.io/en/latest/user/BuildLocally.html)
- [Docker 运行时安装](https://docs.docker.com/engine/install/)
- [Nangate45 平台与许可](https://github.com/The-OpenROAD-Project/OpenROAD-flow-scripts/tree/master/flow/platforms/nangate45)

插件不自动安装 Docker、本地编译 OpenROAD 或执行 sudo。缺少这些基础条件时返回官方入口和具体缺项。下载来源目前限定为官方 `openroad/orfs`；不执行网上随机安装脚本。

## CLI 操作

在已有 RTL 项目中显式选择 ORFS，以下目录 `work` 是示例：

```sh
rtl-flow env work --action init
rtl-flow env work --action inspect
rtl-flow env work --action plan
```

`init` 只创建新的 `config/backend.json` 和项目内缓存目录；已有配置不会覆盖。`inspect` 只读已有工具、ORFS 材料、容器引擎及可选下载缓存，不下载环境。可配置：

```json
{
  "schema_version": 1,
  "provider": "orfs",
  "mode": "auto",
  "platform": "nangate45",
  "orfs_root": null,
  "tools": {},
  "cache_dir": ".local/rtl-backend",
  "downloads_dir": null,
  "network": "allow",
  "docker": {
    "image": "openroad/orfs:latest",
    "platform": null,
    "allow_emulation": false
  },
  "estimates": {"acquire": null, "probe": null}
}
```

`orfs_root` 可指向用户已有环境，`tools` 可显式提供 openroad/yosys/klayout/python3/make/docker 的实际可执行路径。路径和主机配置属于项目私有数据，不能提交到插件仓库。

`downloads_dir` 可填写用户已有下载缓存的绝对路径，插件只读列出匹配的源码、工具归档或安装包，不修改缓存，也不把它们伪装成已经安装的环境。需要严格离线时设置 `network=offline`：不访问镜像解析服务，不拉取镜像，只复用完整 native 环境或已有固定身份的官方镜像；源码归档仍需另行构建/安装。

## 计划、资源预检与执行

在线 Docker 计划仅访问官方 OCI 清单元数据，将标签解析成具体架构的 SHA-256 digest，记录压缩传输字节数；此时不拉取镜像层。后续 `pull` 和运行均使用该固定引用。已有镜像优先使用本地 RepoDigest 和架构，离线准备不重新解析浮动标签。

根据实际工具/平台和元数据填写 `estimates.acquire` 与 `estimates.probe`。它们使用现有任务估算结构：`wall_minutes`、`peak_memory_gib`、`disk_gib`、`basis`、`reason`、`evidence`。`null`、压缩传输大小和安装后大小不可互相替代；不要把未知量填写为零。

补齐估算后重新生成最终计划：

```sh
rtl-flow env work --action plan > work/config/backend-plan.json
rtl-flow env work --action prepare
rtl-flow env work --action check
```

计划绑定当前配置、插件实现摘要、实际工具路径、ORFS/镜像身份及任务 argv。配置或实现改变后必须重新计划，不能手工修改任务或摘要绕过检查。

`prepare` 把新准备任务追加到现有 `config/resource-plan.json`，保留其他任务、预算和 `forecast_complete`。估算格式错误时不改写资源计划；完整预算和全部当前授权工作未梳理时不执行。用户/Agent 需先明确当前阶段范围，并计入已有成本、全部剩余任务、设备内存、磁盘增长及余量。

获取和最小检查通过现有前台串行 `run` 运行器执行，记录原生退出、进程树 RSS、墙钟、项目磁盘增长及原始日志；保留失败、中止和重试成本。容器探针额外限制 CPU、内存、进程数，网络关闭、镜像只读，结束后只清理本次拥有的容器。不启动隐藏调度器，不提高用户预算，不清理全局 Docker 缓存。

磁盘预估表示每项任务的总新增空间上界。运行中已观测的增长计入已用成本，并从该项任务的剩余预估中扣除；失败尝试的成本始终保留。实际增长超出任务上界、项目预算或实际空间余量时停止，重新核对全部剩余工作后才能继续。

Docker 镜像存储可能与项目文件系统不同，因此还要核对实际引擎内存容量和镜像存储文件系统空间，并监测存储余量。当前自动获取基线为可直接测量 DockerRootDir 且与项目共用文件系统的**本地 Linux 引擎**，让镜像增长也进入实际项目记账。独立存储分区需另行适配；Docker Desktop、远程引擎或不可读取的存储空间会明确阻塞，不能拿宿主机空间冒充引擎空间。Docker daemon 是共享服务，镜像拉取的 daemon 内部内存不能由 CLI 进程树 RSS 完整代表，采样不构成系统硬配额。

架构以实际引擎和镜像清单为准。ARM 主机不静默选择 x86 模拟；需要明确设置镜像平台、`allow_emulation=true`，并单独估算资源。缺少匹配清单时停止，不下载错误架构的环境。

## 最小可用性与锁

探针只做以下检查：

1. 读取 OpenROAD、Yosys、KLayout、Python3 与 GNU Make 的版本，记录真实可执行文件摘要。
2. 核对 ORFS 脚本、平台配置、许可、技术 LEF、单元 LEF、Liberty、GDS、RC/技术材料及其摘要。
3. OpenROAD 读取技术/单元 LEF 和 Liberty；Yosys 从 Liberty 导入非零单元；KLayout 读取非空 GDS 单元库。

不提供 DUT，不运行 `make` 的设计目标，不生成设计 GDS，不进行布局、布线、STA 或 DRC/LVS 验收。仅有文件、版本输出或容器启动不算该探针通过。

全部受控任务与探针成功后才写 `config/backend-lock.json` 和 `config/backend-runtime.json`，保存镜像 digest/image id 或原生二进制与材料闭包摘要、实际版本、原始报告绑定和适用边界。失败不生成 ready 锁，旧锁与失败日志保留。`check` 检测配置、插件、原生工具/材料/源文件或镜像身份漂移；有效锁可复用，不重复下载。

环境 `ready` 始终带 `rtl_to_gds_verified=false`。新设计仍需自己的规格、周期、源码、验证、物理约束和资源预算，不能把环境准备冒充 RTL-to-GDS 或制造签核。
