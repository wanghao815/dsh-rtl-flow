# 实际资源检测与预算

项目 budget 字段：wall_minutes（本轮累计原生墙钟预算）、memory_gib（任务/串行进程树峰值上限）、disk_gib（本轮增量预算）、heavy_jobs（上限，当前受控入口串行）、attempts（总尝试上限）、memory_reserve_gib 和 disk_reserve_gib。未知字段为 null，预检不放行。

## 剩余工作与已有耗时

`config/resource-plan.json` schema_version=2，列出 forecast_complete、prior_wall_minutes、disk_spent_gib、workspaces 和 tasks。prior 是未被本运行器 ledger 覆盖的已耗成本，必须注明计量范围，避免重复计算。新项目可从实测 0 起；接手项目须核对历史日志和统计，不凭空假设为 0。

每个 task 需要 id、heavy、depends_on、明确 argv，以及 estimate：wall_minutes、peak_memory_gib、disk_gib、basis（measured 或 upper_bound）、reason、evidence。purpose 默认 design；明确收尾任务写 closeout。measured 必须绑定非空探针文件及 SHA-256；upper_bound 给出保守依据，不能把猜测伪称实测。全部剩余工作未梳理时 forecast_complete=false 阻塞。

最小格式示例（数字仅供说明，不是新项目默认预算）：

```json
{
  "schema_version": 2,
  "forecast_complete": true,
  "prior_wall_minutes": 0,
  "disk_spent_gib": 0,
  "workspaces": ["."],
  "tasks": [{
    "id": "smoke", "heavy": false, "depends_on": [],
    "argv": ["node", "-e", "console.log('SMOKE_DONE')"],
    "estimate": {"wall_minutes": 1, "peak_memory_gib": 0.25, "disk_gib": 0.01,
      "basis": "upper_bound", "reason": "Bounded small Node smoke; verify on this host", "evidence": []}
  }]
}
```

这是受控入口的操作例，不验证 RTL。真实工具命令、所需文件和预算由实际工程给出。

## 真实采样与判据

`rtl-flow resources <root>` 或配置 workspaceRoot 的 rtl_resource_check：读取实际项目计划/运行记录，检测设备总内存、有效进程/容器限制、当前可用内存、CPU 并行度，以及每个已有工作目录所在文件系统的可用空间。项目外工作目录不自动扫描；需要的 scratch 目录应在计划中明确安排并由项目策略支持。

既有已完成/失败/中止 run 的真实墙钟与运行中耗时都计入，不能将失败成本清零。时间预测采用串行总和，扣除当前任务已经消耗的估计时间；超过单任务估计仍未完成就阻塞，要求更新剩余工作。

比较 max(剩余估计峰值, 实际本任务 RSS) 加余量与内存预算、设备有效限制和实际可用内存；运行时将本任务已有 RSS 加回可用容量，避免重复计算。比较历史已用/观测增长及后续增长与增量预算、实际空间和余量。共享卷按 device_id 去重，空间减少可能包含其他写入者，不冒充精确的项目目录用量。

workspaces 必须存在且位于项目内，须覆盖本任务全部输出和 scratch。周期磁盘采样逐目录定位文件系统；启动前及退出后另扫描实际文件占用，取卷空间下降和目录增长的较大值，避免 macOS 空间更新延迟把短写盘任务记成零增长。同一 dev/inode 去重，按逻辑长度与分配长度较大值保守计量，不跟随符号链接。默认单次扫描最多 20 万条目或 30 秒，超限应缩小并完整声明输出工作区，不能忽略未计量区域。项目外或符号链接指向的输出不在该计量内，须由宿主提供覆盖全部文件系统的同等保护。

未知估计、过期探针、设备采样超过 60 秒、依赖环、预算不足和计量缺失都返回明确阻塞原因。当前运行器只支持一个前台任务；并发步骤需拆成一个具有叠加峰值估算的明确任务，或由宿主提供等价保护。

## 前台运行与监测

`rtl-flow run <root> --task <id>`：

1. 持有项目独占锁并写入所有者 PID，先做实际资源预检。暂停项目有明确 closeout 决定时，仅允许 purpose=closeout 的归档/核验任务。原设计任务及失败/中止历史继续保留、已耗成本继续计入，未完成设计列入 stopped_design_tasks，不再作为收尾的剩余执行预测；运行器拒绝启动这些任务。archived 拒绝新增任务。
2. 核对任务存在、执行依赖完成、没有未核对的运行记录或重复完成任务。run 保存任务定义和递归依赖摘要，命令、依赖或定义改变后旧完成记录失效，仍保留实际已耗成本。技术验收依赖与授权由主流程另行核对。
3. 只运行明确 argv，不经 shell。原生 stdout/stderr 写入新日志，无隐藏自动重试。
4. 默认每秒读取本次进程树 RSS，并复查设备空间、已用/剩余时间、预算及项目/计划变化。监测不可用按阻塞处理，避免在失去观测后继续重任务。
5. 超限或取消时先 TERM、必要时 KILL 本次创建的进程组，保留原生 exit_code/signal、原因、墙钟、采样内存和日志摘要；不会按程序名处理其他工程。
6. 退出后补做磁盘占用、配置摘要和累计/剩余预算核对，再写入 runs.json、释放锁。原生命令退出零但最终资源核对失败，记录 failed 并保留 exit_code=0；被取消或受控中止才记 aborted。最终计量缺失写 null，后续预检阻塞。completed 只是操作按预期完成，不算硬件通过；原生工具检查还需 evidence audit。

锁若因外部强杀残留，先检查锁中 PID、命令、日志与实际进程，再由操作者恢复；插件不自动删除未知所有者的锁或重新启动。短任务未采到峰值会明确说明。采样间隔有盲区，RSS 也不等于全部系统内存，因此保守估计、余量和低并发始终必要。

本实现是显式前台资源保护，宿主可监督/取消。它不在后台另建调度器，不全局拦截任意终端命令；绕过此入口的任务必须由宿主提供同等前置检查与持续监测，不能用换一个命令逃避资源阻塞。
