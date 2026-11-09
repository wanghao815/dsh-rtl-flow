// Environment/library validation only. Never supplies RTL or invokes a design target.
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { makeProject, scaffold } from '../src/core.js'
import { writeScaffold } from '../src/audit.js'
import { within } from '../src/common.js'
import { initBackend, backendDefaults, planBackend, prepareBackend, checkBackend } from '../src/backend.js'

const root = resolve(process.env.RUNNER_TEMP || '/tmp', 'rtl-backend-usability')
await mkdir('artifacts', { recursive: true })
try {
  await writeScaffold(root, await scaffold(makeProject({ name: 'ORFS environment usability only', top: 'environment_only', formal: false,
    budget: { wall_minutes: 20, memory_gib: 3, disk_gib: 24, heavy_jobs: 1, attempts: 4, memory_reserve_gib: 1, disk_reserve_gib: 3 } })))
  await initBackend(root)
  const estimate = (wall, memory, disk, reason) => ({ wall_minutes: wall, peak_memory_gib: memory, disk_gib: disk, basis: 'upper_bound', reason, evidence: [] })
  const config = { ...backendDefaults(), mode: 'docker', docker: { image: 'openroad/orfs:latest', platform: 'linux/amd64', allow_emulation: false },
    estimates: { acquire: estimate(8, 2, 20, 'Conservative bounded official-image transfer and unpack on an ephemeral local Linux engine; check manifest and actual engine free space'),
      probe: estimate(5, 2, 0.05, 'One CPU, bounded container; tool versions and Nangate45 library reads only') } }
  await writeFile(resolve(root, 'config/backend.json'), JSON.stringify(config, null, 2))
  await writeFile(resolve(root, 'config/resource-plan.json'), JSON.stringify({ schema_version: 2, forecast_complete: true, prior_wall_minutes: 0, disk_spent_gib: 0, workspaces: ['.'], tasks: [] }, null, 2))
  const plan = await planBackend(root)
  await writeFile(resolve(root, 'config/backend-plan.json'), JSON.stringify(plan, null, 2))
  await writeFile('artifacts/backend-plan.json', JSON.stringify(plan, null, 2))
  if (!plan.can_prepare) throw new Error(plan.issues.join('; '))
  const result = await prepareBackend(root)
  await writeFile('artifacts/backend-prepare.json', JSON.stringify(result, null, 2))
  if (result.status !== 'ready') throw new Error(JSON.stringify(result))
  const verified = await checkBackend(root)
  await writeFile('artifacts/backend-check.json', JSON.stringify(verified, null, 2))
  console.log(JSON.stringify({ status: 'pass', scope: 'Official ORFS image and Nangate45 library usability; no design flow', image: plan.resolved.image,
    rtl_to_gds_verified: false, root }, null, 2))
} finally {
  for (const [name, path] of [['backend-lock.json', 'config/backend-lock.json'], ['backend-runtime.json', 'config/backend-runtime.json'], ['backend-runs.json', 'reports/rtl-flow/runs.json'], ['backend-probe.json', '.local/rtl-backend/probe/result.json']]) {
    try { await writeFile(resolve('artifacts', name), await readFile(await within(root, path))) } catch (e) { if (e.code !== 'ENOENT') throw e }
  }
  try {
    const ledger = JSON.parse(await readFile(resolve(root, 'reports/rtl-flow/runs.json'), 'utf8'))
    for (const run of ledger.runs) if (run.log) await writeFile(resolve('artifacts', `backend-run-${run.id}.log`), await readFile(await within(root, run.log)))
  } catch (e) { if (e.code !== 'ENOENT') throw e }
  try {
    for (const name of await readdir(resolve(root, '.local/rtl-backend/probe'))) if (name.endsWith('.log')) {
      const path = await within(root, `.local/rtl-backend/probe/${name}`)
      if ((await stat(path)).size <= 4 * 1024 * 1024) await writeFile(resolve('artifacts', `backend-${name}`), await readFile(path))
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e }
}
