import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createWriteStream } from 'node:fs'
import { open, realpath, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { inspectResources, probeDevice, probeWorkspaceUsage, assessResources, taskFingerprints } from './resources.js'
import { within, sha256 } from './common.js'
const execFileAsync = promisify(execFile)

async function treeMemory(pid) {
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,rss='], { timeout: 3000, maxBuffer: 8 * 1024 * 1024 })
  const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number)).filter(r => r.length === 3 && r.every(Number.isFinite))
  const owned = new Set([pid])
  let changed = true
  while (changed) { changed = false; for (const [id, parent] of rows) if (owned.has(parent) && !owned.has(id)) { owned.add(id); changed = true } }
  return rows.filter(([id]) => owned.has(id)).reduce((n, r) => n + r[2], 0) / (1024 ** 2)
}

// Explicit foreground command only. No scheduler, retry loop or global process-name killing.
export async function runTask(directory, taskId, signal, { pollMs = 1000 } = {}) {
  if (process.platform === 'win32') throw new Error('Guarded runner currently supports macOS/Linux; use the host runner on Windows with equivalent limits')
  const root = await realpath(directory)
  const ledgerFile = await within(root, 'reports/rtl-flow/runs.json')
  const lockPath = resolve(dirname(ledgerFile), '.run.lock')
  let lock
  try { lock = await open(lockPath, 'wx') } catch (e) { if (e.code === 'EEXIST') throw new Error('A guarded task/lock already exists; inspect its owner before recovery'); throw e }
  const save = async ledger => {
    const temp = `${ledgerFile}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(ledger, null, 2) + '\n', { flag: 'wx' })
    await rename(temp, ledgerFile)
  }
  let owned, ownedExit, closed = false, interval, killing, log, abort
  let monitorPromise = Promise.resolve()
  try {
    await lock.writeFile(JSON.stringify({ owner_pid: process.pid, created_at: new Date().toISOString() }) + '\n')
    signal?.throwIfAborted()
    const preflight = await inspectResources(root, signal)
    if (!preflight.can_start) return { execution_status: 'blocked', preflight }
    const { project, plan, ledger } = preflight
    const task = plan.tasks.find(t => t.id === taskId)
    if (!task) throw new Error('Unknown planned task')
    if (project.delivery.intent === 'closeout' && task.purpose !== 'closeout') return { execution_status: 'blocked', preflight: { ...preflight, can_start: false, issues: ['Closeout does not authorize starting a design task'] } }
    if (ledger.runs.some(r => r.execution_status === 'running')) throw new Error('Existing running task must be reconciled before starting; this runner is serial')
    const latest = new Map(ledger.runs.map(r => [r.task_id, r]))
    const fingerprints = taskFingerprints(plan)
    const completed = id => latest.get(id)?.execution_status === 'completed' && latest.get(id)?.task_sha256 === fingerprints.get(id)
    if (completed(taskId)) throw new Error('Task already executed; plan a separate explicit rerun instead of silently repeating it')
    if (task.depends_on.some(id => !completed(id))) throw new Error('Task execution dependencies are not complete for the current definitions')
    const initialUsage = await probeWorkspaceUsage(root, plan.workspaces)
    const id = randomUUID(), logPath = `reports/rtl-flow/run-${id}.log`
    log = createWriteStream(resolve(root, logPath), { flags: 'wx' })
    await new Promise((ok, fail) => { log.once('open', ok); log.once('error', fail) })
    const started = Date.now(), reasons = []
    const checkpointHash = await sha256(await within(root, 'config/resource-plan.json'))
    const projectHash = await sha256(await within(root, 'rtl-flow.json'))
    const child = owned = spawn(task.argv[0], task.argv.slice(1), { cwd: root, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const run = { id, task_id: task.id, execution_status: 'running', started_at: new Date(started).toISOString(),
      task_sha256: fingerprints.get(task.id), plan_sha256: checkpointHash, project_sha256: projectHash,
      pid: child.pid ?? null, argv: task.argv, log: logPath, peak_memory_gib: 0, wall_minutes: 0 }
    ledger.runs.push(run)
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
    let peak = 0, monitoring = false, diskGrowth = 0, terminated = false
    const measureGrowth = device => {
      const byDevice = new Map()
      for (const disk of device.disks) {
        const initial = preflight.device.disks.find(d => d.workspace === disk.workspace)
        byDevice.set(disk.device_id, Math.max(byDevice.get(disk.device_id) ?? 0, Math.max(0, initial.available_gib - disk.available_gib)))
      }
      diskGrowth = Math.max(diskGrowth, [...byDevice.values()].reduce((a, b) => a + b, 0))
    }
    const stop = reason => {
      if (!reasons.includes(reason)) reasons.push(reason)
      if (closed || killing) return
      terminated = true
      try { if (child.pid) process.kill(-child.pid, 'SIGTERM') } catch { /* Already exited. */ }
      killing = setTimeout(() => { try { if (child.pid && !closed) process.kill(-child.pid, 'SIGKILL') } catch { /* Reaped. */ } }, 2000)
    }
    abort = () => stop('Caller cancelled; only the created process group is terminated')
    signal?.addEventListener('abort', abort, { once: true })
    log.on('error', e => stop(`Native log write failed: ${e.message}`))
    const exit = ownedExit = new Promise(ok => {
      child.once('error', e => reasons.push(`Native spawn error: ${e.message}`))
      child.once('close', (code, nativeSignal) => { closed = true; ok({ code, signal: nativeSignal }) })
    })
    await save(ledger)
    interval = setInterval(() => {
      if (closed || monitoring) return
      monitoring = true
      monitorPromise = (async () => {
      try {
        const rss = await treeMemory(child.pid)
        peak = Math.max(peak, rss)
        if (closed) return
        if (await sha256(await within(root, 'config/resource-plan.json')) !== checkpointHash || await sha256(await within(root, 'rtl-flow.json')) !== projectHash) { stop('Project/resource plan changed during execution'); return }
        measureGrowth(await probeDevice(root, plan.workspaces))
        if (closed) return
        run.disk_growth_upper_bound_gib = diskGrowth
        await save(ledger)
        const current = await inspectResources(root, undefined, { ownedMemoryGiB: rss })
        if (closed) return
        if (!current.can_start) stop(current.issues.join('; '))
      } catch (error) { if (!closed) stop(`Resource monitoring unavailable: ${error.message}`) }
      finally { monitoring = false }
      })()
    }, pollMs)
    if (signal?.aborted) abort()
    const native = await exit
    clearInterval(interval); if (killing) clearTimeout(killing)
    await monitorPromise
    signal?.removeEventListener('abort', abort)
    // A command may have forked descendants; clean up only this invocation's session group.
    try { if (child.pid) process.kill(-child.pid, 'SIGTERM') } catch { /* No descendants remain. */ }
    await new Promise((ok, fail) => { log.once('error', fail); log.end(ok) })
    const status = () => terminated || native.signal ? 'aborted' : reasons.length || native.code !== (task.expected_exit_code ?? 0) ? 'failed' : 'completed'
    Object.assign(run, { execution_status: status(),
      exit_code: native.code, signal: native.signal, reasons, ended_at: new Date().toISOString(), wall_minutes: (Date.now() - started) / 60000,
      peak_memory_gib: peak,
      disk_accounting: 'Maximum observed volume free-space decrease or pre/post workspace size growth; may include external writers. Sampling is not an OS disk quota.',
      memory_sampling: peak > 0 ? 'process tree RSS; sampled' : 'task ended before the first sample', log_sha256: await sha256(resolve(root, logPath)) })
    // Always sample on exit: a short command can finish before the first interval.
    try {
      const finalDevice = await probeDevice(root, plan.workspaces)
      measureGrowth(finalDevice)
      const finalUsage = await probeWorkspaceUsage(root, plan.workspaces)
      diskGrowth = Math.max(diskGrowth, Math.max(0, finalUsage.accounted_gib - initialUsage.accounted_gib))
      run.disk_growth_upper_bound_gib = diskGrowth
      run.workspace_accounting = { before: initialUsage, after: finalUsage }
      if (await sha256(await within(root, 'config/resource-plan.json')) !== checkpointHash || await sha256(await within(root, 'rtl-flow.json')) !== projectHash) reasons.push('Project/resource plan changed during execution')
      if (run.wall_minutes > task.estimate.wall_minutes) reasons.push('Task exceeded its time estimate; revise the remaining forecast')
      if (diskGrowth > task.estimate.disk_gib) reasons.push('Task exceeded its disk-growth estimate; revise the remaining forecast')
      const final = assessResources(project, plan, ledger, finalDevice)
      for (const issue of final.issues) if (!reasons.includes(issue)) reasons.push(issue)
      run.resource_postcheck = { can_continue: final.can_start, sampled_at: finalDevice.sampled_at, issues: final.issues }
    } catch (error) {
      reasons.push(`Final resource measurement unavailable: ${error.message}`)
      run.disk_growth_upper_bound_gib = null
    }
    run.execution_status = status()
    await save(ledger)
    return { ...run, hardware_acceptance: 'not evaluated; parse native reports and audit the evidence separately' }
  } finally {
    if (interval) clearInterval(interval)
    if (killing) clearTimeout(killing)
    if (owned && !closed) {
      try { if (owned.pid) process.kill(-owned.pid, 'SIGTERM') } catch { /* Reaped. */ }
      const force = setTimeout(() => { try { if (owned.pid && !closed) process.kill(-owned.pid, 'SIGKILL') } catch { /* Reaped. */ } }, 2000)
      await ownedExit
      clearTimeout(force)
    }
    await monitorPromise
    if (owned?.pid) {
      try { process.kill(-owned.pid, 'SIGKILL') } catch { /* Only this invocation's remaining descendants, if any. */ }
    }
    signal?.removeEventListener('abort', abort)
    if (log && !log.writableFinished) await new Promise(ok => log.end(ok))
    await lock.close()
    await unlink(lockPath)
  }
}
