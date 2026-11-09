import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { probeDevice, assessResources, validateResourcePlan, inspectResources, taskFingerprints } from '../src/resources.js'
import { runTask } from '../src/runner.js'
import { spawnSync } from 'node:child_process'
import { fresh, fixture } from './helpers.js'

const budget = { wall_minutes: 60, memory_gib: 8, disk_gib: 20, heavy_jobs: 1, attempts: 10, memory_reserve_gib: 1, disk_reserve_gib: 2 }
const task = (id = 'route') => ({ id, heavy: true, depends_on: [], argv: [process.execPath, '-e', 'console.log("TOOL_DONE")'],
  estimate: { wall_minutes: 10, peak_memory_gib: 4, disk_gib: 3, basis: 'upper_bound', reason: 'Conservative unit fixture bound', evidence: [] } })
const plan = () => ({ schema_version: 2, forecast_complete: true, prior_wall_minutes: 5, disk_spent_gib: 1, workspaces: ['.'], tasks: [task()] })
const ledger = () => ({ schema_version: 2, runs: [] })
const device = () => ({ sampled_at: new Date().toISOString(), total_memory_gib: 24, effective_memory_limit_gib: 24, available_memory_gib: 12, disks: [{ workspace: '.', available_gib: 100 }] })

test('resource check accounts elapsed time and all remaining work, not just the next command', () => {
  const p = fresh({ budget }), forecast = plan()
  forecast.tasks.push({ ...task('drc'), depends_on: ['route'], estimate: { ...task().estimate, wall_minutes: 50 } })
  const r = assessResources(p, forecast, ledger(), device())
  assert.equal(r.can_start, false); assert.equal(r.elapsed_minutes, 5); assert.equal(r.remaining_minutes, 60)
  assert.ok(r.issues.some(i => i.includes('remaining project forecast')))
})

test('actual device capacity, available memory, disk growth and reserves each block independently', () => {
  const p = fresh({ budget })
  assert.equal(assessResources(p, plan(), ledger(), device()).can_start, true)
  for (const snapshot of [{ ...device(), effective_memory_limit_gib: 3 }, { ...device(), available_memory_gib: 2 }, { ...device(), disks: [{ workspace: '.', available_gib: 3 }] }]) assert.equal(assessResources(p, plan(), ledger(), snapshot).can_start, false)
  assert.equal(assessResources(fresh({ budget: { ...budget, disk_gib: 2 } }), plan(), ledger(), device()).can_start, false)
  assert.equal(assessResources(p, plan(), ledger(), { ...device(), sampled_at: '2000-01-01T00:00:00Z' }).can_start, false)
  const actual = assessResources(fresh({ budget: { ...budget, memory_gib: 16, memory_reserve_gib: 2 } }), plan(), ledger(),
    { ...device(), total_memory_gib: 8, effective_memory_limit_gib: 8, available_memory_gib: 0 }, { ownedMemoryGiB: 8 })
  assert.equal(actual.can_start, false); assert.equal(actual.checks.memory_required_gib, 8)
})

test('unknown estimates, unmeasured probe claims, task cycles and past retries cannot be treated as zero', () => {
  const p = fresh({ budget }), f = plan()
  f.tasks[0].estimate.peak_memory_gib = null
  assert.equal(assessResources(p, f, ledger(), device()).can_start, false)
  const measured = plan(); measured.tasks[0].estimate.basis = 'measured'
  assert.ok(validateResourcePlan(measured, ledger()).some(i => i.includes('probe evidence')))
  const cycle = plan(); cycle.tasks.push({ ...task('drc'), depends_on: ['route'] }); cycle.tasks[0].depends_on = ['drc']
  assert.ok(validateResourcePlan(cycle, ledger()).some(i => i.includes('cycle')))
  const runs = { schema_version: 2, runs: [{ task_id: 'route', execution_status: 'failed', started_at: new Date().toISOString(), wall_minutes: 59, disk_growth_upper_bound_gib: 0 }] }
  assert.equal(assessResources(p, plan(), runs, device()).can_start, false)
  assert.equal(assessResources(fresh(), plan(), ledger(), device()).can_start, false)
})

test('read-only probe obtains real host memory and filesystem free space', async () => {
  const d = await probeDevice(process.cwd())
  assert.ok(d.total_memory_gib > 0); assert.ok(d.available_memory_gib >= 0); assert.ok(d.disks[0].available_gib >= 0)
  assert.equal(typeof d.disks[0].device_id, 'string')
})

async function runnable() {
  const f = await fixture({ budget: { wall_minutes: 2, memory_gib: 1, disk_gib: 1, heavy_jobs: 1, attempts: 4, memory_reserve_gib: 0, disk_reserve_gib: 0 } })
  const forecast = { schema_version: 2, forecast_complete: true, prior_wall_minutes: 0, disk_spent_gib: 0, workspaces: ['.'], tasks: [{ ...task('probe'), heavy: false,
    estimate: { wall_minutes: 0.5, peak_memory_gib: 0.02, disk_gib: 0.001, basis: 'upper_bound', reason: 'Small bounded Node process; no EDA', evidence: [] } }] }
  await f.put('config/resource-plan.json', forecast)
  return { ...f, forecast }
}

test('guarded foreground runner records actual native completion; does not infer hardware acceptance', async () => {
  const f = await runnable()
  const run = await runTask(f.root, 'probe', new AbortController().signal)
  assert.equal(run.execution_status, 'completed', JSON.stringify(run))
  assert.equal(run.exit_code, 0); assert.ok(run.wall_minutes >= 0)
  assert.match(await readFile(join(f.root, run.log), 'utf8'), /TOOL_DONE/)
  assert.match(run.hardware_acceptance, /not evaluated/)
  await assert.rejects(runTask(f.root, 'probe'), /already executed/)
})

test('insufficient preflight blocks a command before any native process starts', async () => {
  const f = await runnable(); f.project.budget.memory_gib = 0.001; await f.save()
  const r = await runTask(f.root, 'probe')
  assert.equal(r.execution_status, 'blocked')
  const runs = JSON.parse(await readFile(join(f.root, 'reports/rtl-flow/runs.json'), 'utf8'))
  assert.equal(runs.runs.length, 0)
})

test('changed task definitions invalidate execution completion and dependency reuse', async () => {
  const f = await runnable()
  assert.equal((await runTask(f.root, 'probe')).execution_status, 'completed')
  const original = taskFingerprints(f.forecast).get('probe')
  f.forecast.tasks[0].argv = [process.execPath, '-e', 'process.exit(1)']
  f.forecast.tasks.push({ ...f.forecast.tasks[0], id: 'consumer', depends_on: ['probe'], argv: [process.execPath, '-e', 'console.log("CONSUMED")'] })
  assert.notEqual(taskFingerprints(f.forecast).get('probe'), original)
  await f.put('config/resource-plan.json', f.forecast)
  const check = await inspectResources(f.root)
  assert.deepEqual(check.stale_completed_tasks, ['probe'])
  assert.equal(check.remaining_tasks.length, 2)
  await assert.rejects(runTask(f.root, 'consumer'), /dependencies are not complete/)
  const rerun = await runTask(f.root, 'probe')
  assert.equal(rerun.execution_status, 'failed'); assert.equal(rerun.exit_code, 1)
})

test('short writes receive a final disk measurement and cannot silently overrun budget', async () => {
  const f = await runnable()
  f.project.budget.disk_gib = 1 / 1024
  f.forecast.tasks[0].estimate.disk_gib = 0.1 / 1024
  f.forecast.tasks[0].argv = [process.execPath, '-e', 'const fs=require("fs"); const fd=fs.openSync("short-write.bin","w"); fs.writeSync(fd,Buffer.alloc(4*1024*1024,1)); fs.fsyncSync(fd); fs.closeSync(fd)']
  await f.save(); await f.put('config/resource-plan.json', f.forecast)
  const r = await runTask(f.root, 'probe', undefined, { pollMs: 60000 })
  assert.equal(r.exit_code, 0); assert.equal(r.execution_status, 'failed', JSON.stringify(r))
  assert.ok(r.disk_growth_upper_bound_gib > f.project.budget.disk_gib, JSON.stringify(r))
  assert.ok(r.reasons.some(s => s.includes('disk budget')))
  assert.equal((await inspectResources(f.root)).can_start, false)
})

test('explicit closeout tasks remain resource guarded while paused design work stays stopped', async () => {
  const f = await runnable()
  f.forecast.tasks[0].argv = [process.execPath, '-e', 'process.exit(1)']
  await f.put('config/resource-plan.json', f.forecast)
  assert.equal((await runTask(f.root, 'probe')).execution_status, 'failed')
  f.project.state = 'paused'; f.project.delivery = { intent: 'closeout', decision: { id: 'D-close', reason: 'Archive current experiment only' }, exclusions: [] }
  await f.save()
  assert.equal((await runTask(f.root, 'probe')).execution_status, 'blocked')
  f.forecast.tasks.push({ ...f.forecast.tasks[0], id: 'archive', purpose: 'closeout', argv: [process.execPath, '-e', 'console.log("ARCHIVE_CHECK")'] })
  await f.put('config/resource-plan.json', f.forecast)
  const check = await inspectResources(f.root)
  assert.equal(check.can_start, true); assert.deepEqual(check.stopped_design_tasks, ['probe'])
  assert.deepEqual(check.remaining_tasks.map(t => t.id), ['archive'])
  assert.ok(check.elapsed_minutes > 0)
  assert.equal((await runTask(f.root, 'archive')).execution_status, 'completed')
  const actual = JSON.parse(await readFile(join(f.root, 'reports/rtl-flow/runs.json'), 'utf8'))
  assert.equal(actual.runs[0].execution_status, 'failed'); assert.equal(actual.runs[1].execution_status, 'completed')
})

test('cancellation preserves an aborted result even when the native process handles TERM with exit zero', async () => {
  const f = await runnable()
  f.forecast.tasks[0].argv = [process.execPath, '-e', 'process.on("SIGTERM",()=>process.exit(0)); console.log("READY"); setInterval(()=>{},1000)']
  await f.put('config/resource-plan.json', f.forecast)
  const c = new AbortController()
  const pending = runTask(f.root, 'probe', c.signal)
  setTimeout(() => c.abort(), 150)
  const r = await pending
  assert.equal(r.execution_status, 'aborted'); assert.ok(r.reasons.some(s => s.includes('cancelled')))
  await assert.rejects(stat(join(f.root, 'reports/rtl-flow/.run.lock')), e => e.code === 'ENOENT')
})

test('live process-tree monitor aborts an underestimated task, or fails closed if process inspection is unavailable', async t => {
  const f = await runnable()
  f.project.budget.memory_gib = 0.005
  f.forecast.tasks[0].estimate.peak_memory_gib = 0.001
  f.forecast.tasks[0].estimate.reason = 'Deliberately underestimated negative-control bound for the monitor'
  f.forecast.tasks[0].argv = [process.execPath, '-e', 'setInterval(()=>{},1000)']
  await f.save(); await f.put('config/resource-plan.json', f.forecast)
  const ps = spawnSync('/bin/ps', ['-p', String(process.pid), '-o', 'rss='], { encoding: 'utf8' })
  const c = new AbortController(), timeout = setTimeout(() => c.abort(), 5000)
  const r = await runTask(f.root, 'probe', c.signal, { pollMs: 100 })
  clearTimeout(timeout)
  assert.equal(r.execution_status, 'aborted')
  if (ps.status === 0) {
    assert.ok(r.reasons.some(s => s.includes('memory exceeded budget')), JSON.stringify(r))
    assert.ok(r.peak_memory_gib > f.project.budget.memory_gib)
    t.diagnostic('Actual process-tree RSS exceeded its declared budget and the owned task was terminated')
  } else {
    assert.ok(r.reasons.some(s => s.includes('monitoring unavailable')), JSON.stringify(r))
    t.diagnostic('Process inspection unavailable in this environment; verified fail-closed behavior')
  }
})
