import os from 'node:os'
import { realpath, statfs, stat, readFile, lstat, opendir } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'
import { plain, text, isRelative, hashString, sha256, within, smallRead, digest } from './common.js'
import { validateProject, BUDGET_KEYS } from './core.js'
const GiB = 1024 ** 3
const nonnegative = v => typeof v === 'number' && Number.isFinite(v) && v >= 0
const positive = v => nonnegative(v) && v > 0

export async function probeDevice(directory, workspaces = ['.']) {
  const root = await realpath(directory), disks = []
  for (const path of workspaces) {
    if (path !== '.' && !isRelative(path)) throw new Error('Workspace must be . or a project-relative directory')
    const full = await realpath(resolve(root, path)), rel = relative(root, full)
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Workspace leaves project root')
    const fs = await statfs(full, { bigint: true })
    disks.push({ workspace: path, device_id: String((await stat(full)).dev), available_gib: Number(fs.bavail * fs.bsize) / GiB, total_gib: Number(fs.blocks * fs.bsize) / GiB })
  }
  let available = os.freemem(), memory_source = 'os.freemem (conservative; reclaimable cache is not assumed available)'
  if (process.platform === 'linux') {
    try {
      const m = (await readFile('/proc/meminfo', 'utf8')).match(/^MemAvailable:\s+(\d+) kB/m)
      if (m) { available = +m[1] * 1024; memory_source = 'Linux MemAvailable' }
    } catch { /* Conservative portable fallback remains explicit. */ }
  }
  const processAvailable = process.availableMemory?.()
  if (processAvailable > 0) available = Math.min(available, processAvailable)
  const constrained = process.constrainedMemory?.()
  return { sampled_at: new Date().toISOString(), platform: process.platform, arch: process.arch, cpu_threads: os.availableParallelism(),
    total_memory_gib: os.totalmem() / GiB, effective_memory_limit_gib: (constrained > 0 ? Math.min(constrained, os.totalmem()) : os.totalmem()) / GiB,
    available_memory_gib: available / GiB, memory_source, disks }
}

export async function probeWorkspaceUsage(directory, workspaces, { maxEntries = 200000, maxMs = 30000 } = {}) {
  const root = await realpath(directory), pending = [], seen = new Set(), started = Date.now()
  for (const path of workspaces) {
    if (path !== '.' && !isRelative(path)) throw new Error('Invalid workspace path')
    const full = await realpath(resolve(root, path)), rel = relative(root, full)
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Workspace leaves project root')
    pending.push(full)
  }
  let entries = 0, bytes = 0
  while (pending.length) {
    if (++entries > maxEntries || Date.now() - started > maxMs) throw new Error('Workspace accounting limit reached; narrow declared workspaces before starting')
    const path = pending.pop()
    let info
    try { info = await lstat(path) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if (info.isSymbolicLink()) continue // External/symlink scratch must be declared and reconciled explicitly.
    const key = `${info.dev}:${info.ino}`
    if (seen.has(key)) continue
    seen.add(key)
    bytes += Math.max(info.size, (info.blocks ?? 0) * 512)
    if (info.isDirectory()) for await (const entry of await opendir(path)) pending.push(resolve(path, entry.name))
  }
  return { sampled_at: new Date().toISOString(), entries, accounted_gib: bytes / GiB,
    method: 'Unique dev/inode; maximum of logical and allocated bytes; symlinks not followed' }
}

export function validateResourcePlan(plan, ledger) {
  const issues = []
  if (!plain(plan) || plan.schema_version !== 2 || !Array.isArray(plan.tasks)) return ['resource plan needs schema_version=2 and tasks[]']
  if (!plain(ledger) || ledger.schema_version !== 2 || !Array.isArray(ledger.runs)) return ['run ledger needs schema_version=2 and runs[]']
  if (!nonnegative(plan.prior_wall_minutes) || !nonnegative(plan.disk_spent_gib)) issues.push('prior_wall_minutes/disk_spent_gib must be measured nonnegative values')
  if (plan.forecast_complete !== true) issues.push('Remaining project work has not been fully estimated')
  if (!Array.isArray(plan.workspaces) || !plan.workspaces.length || !plan.workspaces.every(p => p === '.' || isRelative(p))) issues.push('workspaces must be existing project-relative directories')
  const ids = new Set()
  for (const task of plan.tasks) {
    if (!plain(task) || !text(task.id) || ids.has(task.id)) { issues.push('Invalid/duplicate task id'); continue }
    ids.add(task.id)
    if (task.purpose !== undefined && !['design', 'closeout'].includes(task.purpose)) issues.push(`${task.id}: purpose must be design or closeout`)
    if (task.expected_exit_code !== undefined && !Number.isInteger(task.expected_exit_code)) issues.push(`${task.id}: expected_exit_code must be an integer`)
    if (typeof task.heavy !== 'boolean' || !Array.isArray(task.depends_on) || !task.depends_on.every(text)) issues.push(`${task.id}: explicit heavy flag/dependencies required`)
    const e = task.estimate
    if (!plain(e) || !positive(e.wall_minutes) || !positive(e.peak_memory_gib) || !nonnegative(e.disk_gib) || !['measured', 'upper_bound'].includes(e.basis) || !text(e.reason)) issues.push(`${task.id}: time/memory/disk estimate, basis and reason required`)
    if (e?.basis === 'measured' && (!Array.isArray(e.evidence) || !e.evidence.length)) issues.push(`${task.id}: measured estimate needs probe evidence`)
    if (Array.isArray(e?.evidence)) for (const f of e.evidence) if (!plain(f) || !isRelative(f.path) || !hashString(f.sha256)) issues.push(`${task.id}: invalid probe evidence hash`)
    if (!Array.isArray(task.argv) || !task.argv.length || !task.argv.every(text)) issues.push(`${task.id}: explicit argv required; shell strings are not accepted`)
  }
  for (const task of plan.tasks) if (plain(task) && Array.isArray(task.depends_on)) for (const id of task.depends_on) if (!ids.has(id) || id === task.id) issues.push('Unknown/self task dependency')
  const visiting = new Set(), visited = new Set()
  const visit = id => {
    if (visiting.has(id)) { issues.push('Task dependency cycle'); return }
    if (visited.has(id)) return
    visiting.add(id)
    const deps = plan.tasks.find(t => t?.id === id)?.depends_on
    for (const dep of Array.isArray(deps) ? deps : []) if (ids.has(dep)) visit(dep)
    visiting.delete(id); visited.add(id)
  }
  for (const id of ids) visit(id)
  for (const run of ledger.runs) {
    if (!plain(run) || !ids.has(run.task_id) || !['running', 'completed', 'failed', 'aborted'].includes(run.execution_status) || !Number.isFinite(Date.parse(run.started_at))) issues.push('Invalid run entry or unknown task')
    else if (run.execution_status !== 'running' && (!nonnegative(run.wall_minutes) || !nonnegative(run.disk_growth_upper_bound_gib))) issues.push('Completed/aborted run lacks actual wall time/disk accounting')
    else if (run.disk_growth_upper_bound_gib !== undefined && !nonnegative(run.disk_growth_upper_bound_gib)) issues.push('Invalid observed run disk growth')
  }
  return issues
}

// Dependency digests invalidate downstream completion when an upstream task changes.
export function taskFingerprints(plan) {
  const results = new Map(), visiting = new Set()
  const visit = id => {
    if (results.has(id)) return results.get(id)
    if (visiting.has(id)) throw new Error('Task dependency cycle')
    visiting.add(id)
    const task = plan.tasks.find(t => t.id === id)
    const value = digest({ task, dependencies: task.depends_on.map(dep => [dep, visit(dep)]) })
    visiting.delete(id); results.set(id, value); return value
  }
  for (const task of plan.tasks) visit(task.id)
  return results
}

export function assessResources(project, plan, ledger, device, { now = Date.now(), ownedMemoryGiB = 0 } = {}) {
  const issues = [...validateProject(project), ...validateResourcePlan(plan, ledger)]
  const result = { can_start: false, issues, sampled_at: device?.sampled_at, elapsed_minutes: null, remaining_minutes: null, remaining_tasks: [], checks: {} }
  if (issues.length) return result
  const closeout = project.delivery.intent === 'closeout' && plain(project.delivery.decision)
  if (project.state === 'archived' || (project.state !== 'active' && !closeout)) issues.push('Lifecycle does not authorize starting work')
  if (!nonnegative(ownedMemoryGiB)) issues.push('Invalid actual owned memory measurement')
  for (const key of BUDGET_KEYS) if (project.budget[key] === null) issues.push(`Budget undecided: ${key}`)
  if (!plain(device) || !Number.isFinite(Date.parse(device.sampled_at)) || now - Date.parse(device.sampled_at) > 60000 || now < Date.parse(device.sampled_at) - 1000) issues.push('Device snapshot missing/stale')
  if (!positive(device?.total_memory_gib) || !positive(device?.effective_memory_limit_gib) || !nonnegative(device?.available_memory_gib) || !Array.isArray(device?.disks) || !device.disks.length) issues.push('Incomplete device memory/disk measurements')
  if (issues.length) return result
  const latest = new Map(ledger.runs.map(r => [r.task_id, r]))
  const fingerprints = taskFingerprints(plan)
  const completed = new Set([...latest.values()].filter(r => r.execution_status === 'completed' && r.task_sha256 === fingerprints.get(r.task_id)).map(r => r.task_id))
  const running = ledger.runs.filter(r => r.execution_status === 'running')
  if (running.length > 1) issues.push('This resource model supports one foreground task at a time')
  if (new Set(running.map(r => r.task_id)).size !== running.length) issues.push('Duplicate running task records')
  if (running.some(r => r.task_sha256 !== fingerprints.get(r.task_id))) issues.push('Running task definition/dependencies changed')
  const activeTime = r => Math.max(0, (now - Date.parse(r.started_at)) / 60000)
  const elapsed = plan.prior_wall_minutes + ledger.runs.reduce((sum, r) => sum + (r.execution_status === 'running' ? activeTime(r) : r.wall_minutes), 0)
  const unfinished = plan.tasks.filter(t => !completed.has(t.id))
  const stopped = closeout ? unfinished.filter(t => t.purpose !== 'closeout') : []
  const remaining = closeout ? unfinished.filter(t => t.purpose === 'closeout') : unfinished
  if (closeout && running.some(r => plan.tasks.find(t => t.id === r.task_id)?.purpose !== 'closeout')) issues.push('Design task is still running despite the closeout decision')
  const remainingMinutes = remaining.reduce((sum, t) => sum + Math.max(0, t.estimate.wall_minutes - running.filter(r => r.task_id === t.id).reduce((n, r) => n + activeTime(r), 0)), 0)
  const memory = Math.max(ownedMemoryGiB, 0, ...remaining.map(t => t.estimate.peak_memory_gib))
  // A running task's observed growth is already spent. Its estimate bounds total
  // growth, so only the unconsumed part remains; prior failed attempts stay spent.
  const disk = remaining.reduce((sum, t) => sum + Math.max(0, t.estimate.disk_gib - running.filter(r => r.task_id === t.id).reduce((n, r) => n + (r.disk_growth_upper_bound_gib ?? 0), 0)), 0)
  const b = project.budget
  if (elapsed + remainingMinutes > b.wall_minutes) issues.push('Elapsed time plus remaining project forecast exceeds wall-time budget')
  for (const run of running) if (activeTime(run) > plan.tasks.find(t => t.id === run.task_id).estimate.wall_minutes) issues.push('Running task exceeded its time estimate; update remaining work before continuing')
  for (const run of running) if ((run.disk_growth_upper_bound_gib ?? 0) > plan.tasks.find(t => t.id === run.task_id).estimate.disk_gib) issues.push('Running task exceeded its disk-growth estimate; update remaining work before continuing')
  if (memory > b.memory_gib || memory + b.memory_reserve_gib > device.effective_memory_limit_gib) issues.push('Estimated peak memory exceeds budget/device capacity')
  if (memory + b.memory_reserve_gib > device.available_memory_gib + ownedMemoryGiB) issues.push('Insufficient currently available memory for remaining sequential work')
  if (ownedMemoryGiB > b.memory_gib) issues.push('Actual owned process-tree memory exceeded budget')
  const diskSpent = plan.disk_spent_gib + ledger.runs.reduce((n, r) => n + (r.disk_growth_upper_bound_gib ?? 0), 0)
  if (diskSpent + disk > b.disk_gib) issues.push('Disk spent plus remaining growth exceeds project disk budget')
  for (const measured of device.disks) if (!nonnegative(measured.available_gib) || disk + b.disk_reserve_gib > measured.available_gib) issues.push('Insufficient disk space in a measured workspace')
  if (running.filter(r => plan.tasks.find(t => t.id === r.task_id)?.heavy).length > b.heavy_jobs) issues.push('Heavy-job concurrency exceeded')
  if (ledger.runs.length + remaining.filter(t => !running.some(r => r.task_id === t.id)).length > b.attempts) issues.push('Attempt budget insufficient for remaining tasks')
  if (plan.workspaces.some(path => !device.disks.some(d => d.workspace === path))) issues.push('Missing disk measurement for a planned workspace')
  Object.assign(result, { can_start: !issues.length, elapsed_minutes: elapsed, remaining_minutes: remainingMinutes,
    remaining_tasks: remaining.map(t => ({ id: t.id, ...t.estimate })), active_tasks: running.map(r => r.task_id),
    stale_completed_tasks: [...latest.values()].filter(r => r.execution_status === 'completed' && !completed.has(r.task_id)).map(r => r.task_id),
    stopped_design_tasks: stopped.map(t => t.id),
    checks: { memory_required_gib: memory, available_memory_gib: device.available_memory_gib, total_memory_gib: device.total_memory_gib,
      effective_memory_limit_gib: device.effective_memory_limit_gib, remaining_disk_gib: disk, disk_spent_gib: diskSpent,
      remaining_wall_budget_minutes: b.wall_minutes - elapsed, disks: device.disks },
    note: 'Sequential conservative forecast; parallel work requires explicit summed-peak estimates. Unknown estimates block, and execution completion does not certify hardware acceptance.' })
  return result
}

export async function inspectResources(directory, signal, options = {}) {
  const root = await realpath(directory)
  const project = JSON.parse(await smallRead(root, 'rtl-flow.json', signal))
  const plan = JSON.parse(await smallRead(root, 'config/resource-plan.json', signal))
  const ledger = JSON.parse(await smallRead(root, 'reports/rtl-flow/runs.json', signal))
  const validation = [...validateProject(project), ...validateResourcePlan(plan, ledger)]
  if (validation.length) return { can_start: false, issues: validation, project, plan, ledger, device: await probeDevice(root) }
  const device = await probeDevice(root, plan.workspaces)
  const result = assessResources(project, plan, ledger, device, options)
  for (const task of plan.tasks) for (const file of task.estimate.evidence ?? []) {
    try { if (await sha256(await within(root, file.path), signal) !== file.sha256) result.issues.push(`Stale probe: ${file.path}`) }
    catch (error) { if (signal?.aborted) throw error; result.issues.push(error.message) }
  }
  result.can_start = !result.issues.length
  return { ...result, project, plan, ledger, device }
}
