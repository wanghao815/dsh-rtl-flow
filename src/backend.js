import os from 'node:os'
import { constants } from 'node:fs'
import { access, lstat, mkdir, open, readFile, readdir, realpath, rename, stat, statfs, unlink, writeFile } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { canonical, digest, isRelative, plain, sha256, smallRead, text, within } from './common.js'
import { runTask } from './runner.js'
import { inspectResources, validateResourcePlan } from './resources.js'

const exec = promisify(execFile)
const CLI = fileURLToPath(new URL('../bin/rtl-flow.js', import.meta.url))
const PROBE = fileURLToPath(new URL('./backend-probe.py', import.meta.url))
const CONFIG = 'config/backend.json'
const PLAN = 'config/backend-plan.json'
const LOCK = 'config/backend-lock.json'
const GiB = 1024 ** 3
export const BACKEND_LINKS = {
  orfs: 'https://github.com/The-OpenROAD-Project/OpenROAD-flow-scripts',
  docker: 'https://openroad-flow-scripts.readthedocs.io/en/latest/user/DockerShell.html',
  docker_install: 'https://docs.docker.com/engine/install/',
  prebuilt: 'https://openroad-flow-scripts.readthedocs.io/en/latest/user/BuildWithPrebuilt.html',
  native: 'https://openroad-flow-scripts.readthedocs.io/en/latest/user/BuildLocally.html',
  platform: 'https://github.com/The-OpenROAD-Project/OpenROAD-flow-scripts/tree/master/flow/platforms/nangate45',
}
export const backendDefaults = () => ({ schema_version: 1, provider: 'orfs', mode: 'auto', platform: 'nangate45',
  orfs_root: null, tools: {}, cache_dir: '.local/rtl-backend', downloads_dir: null, network: 'allow',
  docker: { image: 'openroad/orfs:latest', platform: null, allow_emulation: false },
  estimates: { acquire: null, probe: null } })
export const PLATFORM_FILES = {
  technology_lef: 'lef/NangateOpenCellLibrary.tech.lef', cell_lef: 'lef/NangateOpenCellLibrary.macro.mod.lef',
  liberty: 'lib/NangateOpenCellLibrary_typical.lib', rc_rules: 'rcx_patterns.rules',
  platform_config: 'config.mk', klayout_technology: 'FreePDK45.lyt',
  platform_license: 'LICENSE', set_rc: 'setRC.tcl',
}
const clean = v => text(v) && !/[\r\n\0]/.test(v)
const imagePattern = /^openroad\/orfs(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[a-f0-9]{64})?$/
const archName = arch => ({ x86_64: 'amd64', x64: 'amd64', aarch64: 'arm64' })[arch] ?? arch

export function validateBackendConfig(c) {
  const issues = []
  if (!plain(c) || c.schema_version !== 1 || c.provider !== 'orfs') return ['Backend config requires schema_version=1 and provider=orfs']
  if (!['auto', 'native', 'docker'].includes(c.mode)) issues.push('mode must be auto, native or docker')
  if (c.platform !== 'nangate45') issues.push('Automated platform support is currently limited to nangate45; other platforms require their own adapter')
  if (!isRelative(c.cache_dir)) issues.push('cache_dir must be a project-relative directory')
  if (!['allow', 'offline'].includes(c.network)) issues.push('network must be allow or offline')
  if (c.downloads_dir !== null && !clean(c.downloads_dir)) issues.push('downloads_dir must be null or an existing read-only cache directory')
  if (c.orfs_root !== null && !clean(c.orfs_root)) issues.push('orfs_root must be null or a single-line directory')
  if (!plain(c.tools) || !Object.values(c.tools).every(clean)) issues.push('tools must map names to executable paths')
  if (!plain(c.docker) || typeof c.docker.image !== 'string' || !imagePattern.test(c.docker.image) || typeof c.docker.allow_emulation !== 'boolean'
    || (c.docker.platform !== null && !/^linux\/(amd64|arm64)$/.test(c.docker.platform))) issues.push('Invalid official image, Linux architecture or emulation choice')
  if (!plain(c.estimates)) issues.push('estimates.acquire/probe must be explicitly provided or null')
  return issues
}
async function command(program, args, signal, cwd, timeout = 15000) {
  if (!program) return { ok: false, code: null, stdout: '', stderr: 'executable not found' }
  try {
    const r = await exec(program, args, { signal, cwd, timeout, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' })
    return { ok: true, code: 0, stdout: r.stdout, stderr: r.stderr }
  } catch (e) {
    signal?.throwIfAborted()
    return { ok: false, code: e.code ?? null, stdout: e.stdout ?? '', stderr: e.stderr || e.message }
  }
}
async function executable(name, configured, dirs = []) {
  if (configured && !clean(configured)) throw new Error('Invalid executable path')
  const candidates = configured ? [isAbsolute(configured) ? configured : resolve(configured)] : [...dirs, ...(process.env.PATH ?? '').split(delimiter)].map(d => resolve(d, name))
  for (const path of candidates) try { await access(path, constants.X_OK); if ((await stat(path)).isFile()) return realpath(path) } catch { /* Keep inspecting. */ }
  return null
}
export async function backendPath(root, path, directory = false) {
  if (!isRelative(path)) throw new Error('Backend output must be project-relative')
  const full = resolve(root, path)
  let ancestor = full
  for (;;) {
    try {
      const info = await lstat(ancestor)
      if (info.isSymbolicLink()) throw new Error('Backend outputs cannot use symbolic links')
      const rel = relative(root, await realpath(ancestor))
      if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Backend output leaves project')
      if (ancestor === full && directory && !info.isDirectory()) throw new Error('Expected backend directory')
      break
    } catch (e) { if (e.code !== 'ENOENT') throw e; ancestor = dirname(ancestor) }
  }
  return full
}
async function json(root, path, signal) { return JSON.parse(await smallRead(root, path, signal)) }
async function writeJSON(root, path, value) {
  const full = await backendPath(root, path)
  await mkdir(dirname(full), { recursive: true })
  await backendPath(root, path)
  const temp = `${full}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
  await rename(temp, full)
}
async function configAt(root, signal) {
  const c = await json(root, CONFIG, signal)
  const issues = validateBackendConfig(c)
  if (issues.length) throw new Error(issues.join('; '))
  await backendPath(root, c.cache_dir, true)
  return c
}
export async function initBackend(directory) {
  const root = await realpath(directory), c = backendDefaults()
  await backendPath(root, c.cache_dir, true)
  const full = await backendPath(root, CONFIG)
  await mkdir(dirname(full), { recursive: true })
  await writeFile(full, JSON.stringify(c, null, 2) + '\n', { flag: 'wx' })
  await mkdir(await backendPath(root, c.cache_dir), { recursive: true })
  return { status: 'draft', config: CONFIG, links: BACKEND_LINKS, note: 'ORFS selected explicitly. Fill estimates and the complete project resource plan before prepare. No downloads performed.' }
}
export async function inspectBackend(directory, signal) {
  const root = await realpath(directory)
  let c
  try { c = await configAt(root, signal) } catch (e) { if (e.code === 'ENOENT') return { status: 'not_selected', links: BACKEND_LINKS, next: 'Choose an existing backend or explicitly use env --action init for ORFS. No acquisition is implicit.' }; throw e }
  const orfsRoot = c.orfs_root ? await realpath(resolve(root, c.orfs_root)) : process.env.ORFS_ROOT ? await realpath(process.env.ORFS_ROOT) : null
  const bins = orfsRoot ? [resolve(orfsRoot, 'tools/install/OpenROAD/bin'), resolve(orfsRoot, 'tools/install/yosys/bin')] : []
  const tools = {}
  for (const name of ['openroad', 'yosys', 'klayout', 'python3', 'make', 'docker']) tools[name] = await executable(name, c.tools[name], bins)
  let nativeComplete = Boolean(orfsRoot && ['openroad', 'yosys', 'klayout', 'python3', 'make'].every(k => tools[k]))
  const files = {}
  if (orfsRoot) for (const [role, path] of Object.entries(PLATFORM_FILES)) {
    const full = resolve(orfsRoot, 'flow/platforms/nangate45', path)
    try { files[role] = (await stat(full)).isFile(); if (!files[role]) nativeComplete = false } catch { files[role] = false; nativeComplete = false }
  }
  if (orfsRoot) try {
    if (!(await readdir(resolve(orfsRoot, 'flow/platforms/nangate45/gds'))).some(v => v.endsWith('.gds'))) nativeComplete = false
    for (const path of ['env.sh', 'flow/Makefile', 'flow/util/docker_shell']) if (!(await stat(resolve(orfsRoot, path))).isFile()) nativeComplete = false
  } catch { nativeComplete = false }
  const archives = []
  if (c.downloads_dir) {
    const directory = await realpath(resolve(root, c.downloads_dir))
    for (const entry of (await readdir(directory, { withFileTypes: true })).slice(0, 256)) {
      if (!entry.isFile() || !/^(OpenROAD(?:-flow-scripts)?-|OpenSTA-|oss-cad-suite-|.*klayout-).*(?:\.tar\.gz|\.tgz|\.dmg)$/.test(entry.name)) continue
      const path = resolve(directory, entry.name), info = await stat(path)
      archives.push({ path, name: entry.name, bytes: info.size, kind: entry.name.endsWith('.dmg') ? 'installer_archive' : 'source_or_tool_archive', ready: false })
    }
  }
  let docker = { available: false }
  if (tools.docker && c.mode !== 'native') {
    const info = await command(tools.docker, ['info', '--format', '{{json .}}'], signal)
    if (info.ok) {
      const i = JSON.parse(info.stdout)
      const ctx = await command(tools.docker, ['context', 'inspect'], signal)
      const host = ctx.ok ? JSON.parse(ctx.stdout)[0]?.Endpoints?.docker?.Host : null
      docker = { available: true, os: i.OSType, architecture: archName(i.Architecture), memory_gib: i.MemTotal / GiB,
        root: i.DockerRootDir, local_linux_store: process.platform === 'linux' && host?.startsWith('unix://') === true,
        identity: digest({ id: i.ID, server: i.ServerVersion, host, root: i.DockerRootDir, arch: i.Architecture }) }
      if (docker.local_linux_store) try { const fs = await statfs(docker.root); docker.disk_free_gib = fs.bavail * fs.bsize / GiB } catch { docker.disk_free_gib = null }
    } else docker.error = info.stderr
  }
  return { status: 'detected', config_sha256: digest(c), requested_mode: c.mode, platform: c.platform, orfs_root: orfsRoot, tools,
    native_complete: nativeComplete, native_files: files, archives, docker, links: BACKEND_LINKS,
    note: 'Presence detection is not usability or RTL-to-GDS verification.' }
}

async function fetchBytes(url, headers, signal) {
  const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20000)]) })
  if (!response.ok) throw new Error(`Official registry metadata HTTP ${response.status}`)
  let size = 0; const chunks = []
  for await (const chunk of response.body) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new Error('Registry metadata exceeds size limit'); chunks.push(chunk) }
  return { body: Buffer.concat(chunks), digest: response.headers.get('docker-content-digest') }
}
export async function resolveOfficialImage(image, platform, signal) {
  if (!imagePattern.test(image)) throw new Error('Only the official openroad/orfs image is supported')
  const tokenData = await fetchBytes('https://auth.docker.io/token?service=registry.docker.io&scope=repository:openroad/orfs:pull', {}, signal)
  const token = JSON.parse(tokenData.body).token
  if (!text(token)) throw new Error('Anonymous registry token unavailable')
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' }
  const get = async ref => {
    const r = await fetchBytes(`https://registry-1.docker.io/v2/openroad/orfs/manifests/${encodeURIComponent(ref)}`, headers, signal)
    const sum = `sha256:${createHash('sha256').update(r.body).digest('hex')}`
    if (r.digest && r.digest !== sum) throw new Error('Registry manifest digest mismatch')
    if (ref.startsWith('sha256:') && ref !== sum) throw new Error('Requested manifest digest mismatch')
    return { value: JSON.parse(r.body), digest: sum }
  }
  const requested = image.includes('@') ? image.split('@')[1] : image.includes(':') ? image.split(':')[1] : 'latest'
  let m = await get(requested)
  const indexDigest = m.digest
  if (Array.isArray(m.value.manifests)) {
    const [system, architecture] = platform.split('/')
    const selected = m.value.manifests.find(v => v.platform?.os === system && v.platform?.architecture === architecture)
    if (!selected || !/^sha256:[a-f0-9]{64}$/.test(selected.digest)) throw new Error(`Official image has no ${platform} manifest; choose a supported architecture explicitly`)
    m = await get(selected.digest)
  }
  if (!Array.isArray(m.value.layers) || !m.value.layers.length || !m.value.layers.every(v => Number.isSafeInteger(v.size) && v.size > 0)) throw new Error('Invalid image layer metadata')
  return { requested: image, reference: `openroad/orfs@${m.digest}`, index_digest: indexDigest, digest: m.digest, platform,
    compressed_bytes: m.value.layers.reduce((n, v) => n + v.size, 0), note: 'Compressed transfer size is not unpacked disk usage. Supply a conservative unpack/download estimate.' }
}

async function implementationIdentity() { return digest({ backend: await sha256(fileURLToPath(import.meta.url)), cli: await sha256(CLI), probe: await sha256(PROBE) }) }
async function nativeSnapshot(orfsRoot, tools) {
  const files = new Set(Object.entries(tools).filter(([name, path]) => name !== 'docker' && path).map(([, path]) => path))
  const roots = ['flow/scripts', 'flow/util', 'flow/platforms/common', 'flow/platforms/nangate45']
  const walk = async path => {
    let info
    try { info = await lstat(path) } catch (e) { if (e.code === 'ENOENT') return; throw e }
    if (info.isSymbolicLink()) {
      const actual = await realpath(path), rel = relative(orfsRoot, actual)
      if (rel.startsWith('../') || rel === '..' || isAbsolute(rel)) throw new Error('ORFS material link leaves the selected root')
      if ((await stat(actual)).isDirectory()) throw new Error('Directory links in the ORFS closure need an explicit adapter')
      files.add(actual)
    } else if (info.isDirectory()) for (const e of await readdir(path)) await walk(resolve(path, e))
    else if (info.isFile()) files.add(path)
    if (files.size > 20000) throw new Error('ORFS source/material closure exceeds the snapshot limit')
  }
  for (const path of ['env.sh', 'flow/Makefile', ...roots]) await walk(resolve(orfsRoot, path))
  return Promise.all([...files].sort().map(async path => { const info = await stat(path, { bigint: true }); return { path, bytes: String(info.size), mtime_ns: String(info.mtimeNs), inode: String(info.ino) } }))
}
function taskDefinitions(c, identity, resolved, tools) {
  const suffix = identity.slice(0, 16), tasks = []
  if (resolved.mode === 'docker' && resolved.acquire) tasks.push({ id: `backend-pull-${suffix}`, heavy: true, depends_on: [],
    argv: [tools.docker, 'pull', '--platform', resolved.image.platform, resolved.image.reference], estimate: c.estimates.acquire,
    backend_identity: identity })
  tasks.push({ id: `backend-probe-${suffix}`, heavy: true, depends_on: tasks.map(t => t.id),
    argv: [process.execPath, CLI, 'backend-probe', resolved.root, '--config', PLAN], estimate: c.estimates.probe, backend_identity: identity })
  return tasks
}
export async function planBackend(directory, signal, { resolveImage = resolveOfficialImage } = {}) {
  const root = await realpath(directory), c = await configAt(root, signal), detected = await inspectBackend(root, signal)
  const mode = c.mode === 'auto' ? detected.native_complete ? 'native' : 'docker' : c.mode
  const issues = [], resolved = { mode, root, orfs_root: detected.orfs_root, tools: detected.tools }
  if (mode === 'native') {
    if (!detected.native_complete) issues.push('Native tools or selected ORFS platform files are missing; provide an existing ORFS root or select Docker acquisition')
    else resolved.input_snapshot = await nativeSnapshot(detected.orfs_root, detected.tools)
  } else {
    const arch = detected.docker.architecture ?? archName(process.arch)
    const platform = c.docker.platform ?? `linux/${arch}`
    if (arch !== platform.split('/')[1] && !c.docker.allow_emulation) issues.push('Cross-architecture execution needs explicit allow_emulation=true and its own resource estimate')
    if (!detected.docker.available) issues.push('Docker CLI/daemon unavailable; install the container runtime using the official link before acquisition')
    if (detected.docker.available && (!detected.docker.local_linux_store || !Number.isFinite(detected.docker.disk_free_gib))) issues.push('Actual Docker engine-store free space cannot be measured. Automatic acquisition currently requires a local Linux engine with an accessible DockerRootDir; do not substitute host space for Docker Desktop/remote storage')
    let cached = null
    if (detected.tools.docker && detected.docker.available) {
      const r = await command(detected.tools.docker, ['image', 'inspect', c.docker.image], signal)
      if (r.ok) {
        const i = JSON.parse(r.stdout)[0]
        const reference = i.RepoDigests?.find(v => /^openroad\/orfs@sha256:[a-f0-9]{64}$/.test(v))
        if (reference && `${i.Os}/${archName(i.Architecture)}` === platform) cached = { requested: c.docker.image, reference, digest: reference.split('@')[1], platform, image_id: i.Id, compressed_bytes: null }
      }
    }
    if (!cached && c.network === 'offline') issues.push('Offline mode forbids image acquisition; source/installer archives are not installed tools or an OCI image. Provide a complete native environment or a cached locked Docker image')
    resolved.image = cached ?? (c.network === 'offline' || !detected.docker.available ? null : await resolveImage(c.docker.image, platform, signal))
    resolved.acquire = !cached
    resolved.engine = detected.docker
    if (resolved.image && (resolved.image.platform !== platform || !/^openroad\/orfs@sha256:[a-f0-9]{64}$/.test(resolved.image.reference))) throw new Error('Invalid resolved image identity')
  }
  const implementation = await implementationIdentity(), configHash = digest(c)
  const identity = digest({ config: configHash, implementation, resolved })
  return { schema_version: 1, provider: 'orfs', config_sha256: configHash, implementation_sha256: implementation, identity,
    resolved, tasks: resolved.mode === 'docker' && !resolved.image ? [] : taskDefinitions(c, identity, resolved, detected.tools), issues, can_prepare: !issues.length,
    links: BACKEND_LINKS, next: `Save this plan as ${PLAN}. prepare appends these tasks without changing budgets or forecast_complete; the complete resource preflight must pass.` }
}
async function verifiedPlan(root, signal) {
  const c = await configAt(root, signal), p = await json(root, PLAN, signal)
  if (p.schema_version !== 1 || p.provider !== 'orfs' || p.config_sha256 !== digest(c) || p.implementation_sha256 !== await implementationIdentity()) throw new Error('Backend plan/config/plugin is stale; regenerate the plan')
  if (!Array.isArray(p.issues) || p.issues.length || p.can_prepare !== true) throw new Error('Backend plan is blocked; resolve issues and regenerate it')
  if (p.identity !== digest({ config: p.config_sha256, implementation: p.implementation_sha256, resolved: p.resolved })
    || p.resolved.root !== root || canonical(p.tasks) !== canonical(taskDefinitions(c, p.identity, p.resolved, p.resolved.tools))) throw new Error('Backend plan identity or tasks were modified')
  const current = await inspectBackend(root, signal)
  const mode = c.mode === 'auto' ? current.native_complete ? 'native' : 'docker' : c.mode
  if (mode !== p.resolved.mode || canonical(current.tools) !== canonical(p.resolved.tools) || current.orfs_root !== p.resolved.orfs_root) throw new Error('Backend paths/selection changed; regenerate the plan')
  if (mode === 'native' && canonical(await nativeSnapshot(current.orfs_root, current.tools)) !== canonical(p.resolved.input_snapshot)) throw new Error('Native tools/materials changed since planning; regenerate the plan')
  if (mode === 'docker' && (!/^openroad\/orfs@sha256:[a-f0-9]{64}$/.test(p.resolved.image?.reference)
      || !/^linux\/(amd64|arm64)$/.test(p.resolved.image.platform)
      || (c.docker.platform && p.resolved.image.platform !== c.docker.platform)
      || (current.docker.architecture !== p.resolved.image.platform.split('/')[1] && !c.docker.allow_emulation)
      || (c.docker.image.includes('@') && c.docker.image !== p.resolved.image.reference)
      || (c.network === 'offline' && p.resolved.acquire))) throw new Error('Invalid or forbidden Docker acquisition plan')
  return { c, p }
}
async function checkDockerIdentity(root, c, p, signal, resources = true) {
  const current = await inspectBackend(root, signal)
  if (!current.docker.available || current.docker.identity !== p.resolved.engine.identity || !current.docker.local_linux_store) throw new Error('Docker context/engine changed or storage cannot be measured; replan')
  if (!resources) return current.docker
  const project = await json(root, 'rtl-flow.json', signal)
  const disk = p.tasks.reduce((n, task) => n + (task.estimate?.disk_gib ?? NaN), 0)
  if (!Number.isFinite(disk) || !Number.isFinite(project.budget.disk_reserve_gib) || current.docker.disk_free_gib < disk + project.budget.disk_reserve_gib) throw new Error('Unknown/insufficient engine disk estimate or actual engine-store space')
  const peak = p.tasks.find(t => t.id.startsWith('backend-probe-'))?.estimate?.peak_memory_gib ?? c.estimates.probe?.peak_memory_gib
  if (!Number.isFinite(peak) || current.docker.memory_gib < peak + (project.budget.memory_reserve_gib ?? NaN)) throw new Error('Unknown/insufficient Docker engine memory allocation')
  return current.docker
}
const containerName = p => `rtl-backend-${p.identity.slice(0, 24)}`
async function cleanupContainer(p) {
  if (p.resolved.mode !== 'docker') return
  const docker = p.resolved.tools.docker, name = containerName(p)
  const found = await command(docker, ['container', 'inspect', name], undefined)
  if (!found.ok) {
    if (/no such (?:object|container)|not found/i.test(found.stderr)) return
    throw new Error('Cannot verify cleanup of the owned backend container: ' + found.stderr)
  }
  const info = JSON.parse(found.stdout)[0]
  if (info.Config?.Labels?.['rtl.flow.backend.identity'] !== p.identity) throw new Error('Container ownership label differs; refusing to remove it')
  const removed = await command(docker, ['rm', '--force', name], undefined)
  if (!removed.ok && !/no such (?:object|container)|not found/i.test(removed.stderr)) throw new Error('Owned backend container cleanup failed: ' + removed.stderr)
}
export async function prepareBackend(directory, signal) {
  const root = await realpath(directory), { c, p } = await verifiedPlan(root, signal)
  const operation = await backendPath(root, `${c.cache_dir}/.prepare.lock`)
  const owned = await open(operation, 'wx').catch(e => { if (e.code === 'EEXIST') throw new Error('Backend prepare lock exists; inspect its owner before retry'); throw e })
  let engine, timer, watchError = null
  const abort = new AbortController(), forward = () => abort.abort(signal.reason)
  signal?.addEventListener('abort', forward, { once: true })
  if (signal?.aborted) forward()
  try {
    await owned.writeFile(JSON.stringify({ owner_pid: process.pid, plan_identity: p.identity }) + '\n')
    try { const locked = await checkBackend(root, signal); if (locked.status === 'ready' && locked.plan_identity === p.identity) return { ...locked, reused: true } } catch { signal?.throwIfAborted() }
    const mutationLock = await open(await backendPath(root, 'reports/rtl-flow/.run.lock'), 'wx')
    try {
      await mutationLock.writeFile(JSON.stringify({ owner_pid: process.pid, purpose: 'append backend tasks' }) + '\n')
      const plan = await json(root, 'config/resource-plan.json', signal), ledger = await json(root, 'reports/rtl-flow/runs.json', signal)
      if (ledger.runs.some(r => r.execution_status === 'running')) throw new Error('Reconcile an existing native run before changing the setup plan')
      for (const task of p.tasks) {
        const existing = plan.tasks.find(t => t.id === task.id)
        if (existing && canonical(existing) !== canonical(task)) throw new Error('Existing backend task differs from the selected plan')
        if (!existing) plan.tasks.push(task)
      }
      const validation = validateResourcePlan(plan, ledger)
      if (validation.length) return { status: 'blocked', issues: validation, rtl_to_gds_verified: false }
      await writeJSON(root, 'config/resource-plan.json', plan)
    } finally { await mutationLock.close(); await unlink(resolve(root, 'reports/rtl-flow/.run.lock')) }
    const preflight = await inspectResources(root, signal)
    if (!preflight.can_start) return { status: 'blocked', preflight, rtl_to_gds_verified: false }
    if (p.resolved.mode === 'docker') {
      engine = await checkDockerIdentity(root, c, p, signal)
      let measuring = false
      timer = setInterval(async () => {
        if (measuring) return
        measuring = true
        try { const fs = await statfs(engine.root); if (fs.bavail * fs.bsize / GiB < preflight.project.budget.disk_reserve_gib) throw new Error('Docker engine disk reserve exhausted') }
        catch (e) { watchError = e.message; abort.abort(e) }
        finally { measuring = false }
      }, 1000)
    }
    for (const task of p.tasks) {
      const ledger = await json(root, 'reports/rtl-flow/runs.json', signal)
      const latest = ledger.runs.filter(r => r.task_id === task.id).at(-1)
      if (latest?.execution_status === 'completed' && !preflight.stale_completed_tasks.includes(task.id)) continue
      const run = await runTask(root, task.id, abort.signal)
      if (run.execution_status !== 'completed') return { status: run.execution_status, run, rtl_to_gds_verified: false }
    }
    await cleanupContainer(p)
    if (watchError) throw new Error(watchError)
    if (engine) await checkDockerIdentity(root, c, { ...p, tasks: [] }, signal)
    const reportPath = `${c.cache_dir}/probe/result.json`, report = await json(root, reportPath, signal)
    const ledger = await json(root, 'reports/rtl-flow/runs.json', signal)
    const lastProbe = ledger.runs.filter(r => r.task_id === p.tasks.at(-1).id).at(-1)
    if (report.status !== 'pass' || report.plan_identity !== p.identity || Date.parse(report.completed_at) < Date.parse(lastProbe.started_at)) throw new Error('Missing, failed or stale minimum-usability report')
    if (p.resolved.mode === 'native') {
      if (canonical(await nativeSnapshot(p.resolved.orfs_root, p.resolved.tools)) !== canonical(p.resolved.input_snapshot)) throw new Error('Native inputs changed during the probe')
      for (const file of [...report.files, ...Object.values(report.tools)]) if (await sha256(file.path) !== file.sha256) throw new Error('Native tool/material digest changed during the probe')
    }
    const lock = { schema_version: 1, generated_by: 'dsh-rtl-flow', provider: 'orfs', status: 'ready', platform: c.platform,
      plan_identity: p.identity, config_sha256: digest(c), implementation_sha256: p.implementation_sha256, mode: p.resolved.mode,
      resolved: p.resolved, probe_report: { path: reportPath, sha256: await sha256(await within(root, reportPath)) },
      tools: report.tools, files: report.files, source_roots: report.source_roots, image_id: report.image_id ?? null, completed_at: new Date().toISOString(),
      scope: 'Tool versions and platform LEF/Liberty/GDS library parsing only', rtl_to_gds_verified: false }
    try { const old = await json(root, LOCK, signal); if (old.generated_by !== 'dsh-rtl-flow') throw new Error('Refusing to replace a foreign backend lock'); await writeJSON(root, `${c.cache_dir}/previous-lock-${randomUUID()}.json`, old) }
    catch (e) { if (e.code !== 'ENOENT') throw e }
    await writeJSON(root, LOCK, lock)
    await writeJSON(root, 'config/backend-runtime.json', { provider: 'orfs', platform: c.platform, mode: lock.mode,
      orfs_root: lock.mode === 'native' ? lock.resolved.orfs_root : '/OpenROAD-flow-scripts', tools: lock.tools,
      image: lock.resolved.image?.reference ?? null, docker_platform: lock.resolved.image?.platform ?? null,
      backend_lock_sha256: await sha256(await within(root, LOCK)), note: 'Future design execution needs its own contracts and resource plan. No RTL-to-GDS was run.' })
    return { status: 'ready', lock: LOCK, plan_identity: p.identity, report: reportPath, reused: false, rtl_to_gds_verified: false }
  } finally {
    if (timer) clearInterval(timer)
    signal?.removeEventListener('abort', forward)
    try { await cleanupContainer(p) }
    finally { await owned.close(); await unlink(operation) }
  }
}
export async function checkBackend(directory, signal) {
  const root = await realpath(directory), c = await configAt(root, signal), lock = await json(root, LOCK, signal)
  if (lock.schema_version !== 1 || lock.generated_by !== 'dsh-rtl-flow' || lock.status !== 'ready'
    || lock.config_sha256 !== digest(c) || lock.implementation_sha256 !== await implementationIdentity()) throw new Error('Backend lock/config/plugin identity is stale')
  if (await sha256(await within(root, lock.probe_report.path)) !== lock.probe_report.sha256) throw new Error('Backend probe report changed')
  if (lock.mode === 'native') {
    const current = await inspectBackend(root, signal)
    for (const [name, tool] of Object.entries(lock.tools)) if (current.tools[name] !== tool.path) throw new Error('Selected native executable changed; replan')
    for (const f of [...lock.files, ...Object.values(lock.tools)]) if (await sha256(f.path) !== f.sha256) throw new Error(`Backend file/tool changed: ${f.path}`)
    const recorded = new Set(lock.files.map(f => f.path)), discovered = new Set()
    const walk = async directory => {
      try {
        for (const e of await readdir(directory, { withFileTypes: true })) {
          const path = resolve(directory, e.name)
          if (e.isDirectory()) await walk(path)
          else if (e.isFile() || e.isSymbolicLink()) discovered.add(await realpath(path))
        }
      } catch (e) { if (e.code !== 'ENOENT') throw e }
    }
    for (const directory of lock.source_roots ?? []) await walk(directory)
    for (const path of discovered) if (!recorded.has(path)) throw new Error('Native ORFS/material input set changed; replan')
  } else {
    await checkDockerIdentity(root, c, { resolved: lock.resolved, tasks: [] }, signal, false)
    const image = await command(lock.resolved.tools.docker, ['image', 'inspect', lock.resolved.image.reference], signal)
    if (!image.ok || JSON.parse(image.stdout)[0]?.Id !== lock.image_id) throw new Error('Locked Docker image is absent or changed')
  }
  return { status: 'ready', plan_identity: lock.plan_identity, lock: LOCK, mode: lock.mode, scope: lock.scope, rtl_to_gds_verified: false }
}

// Internal entry is executed only as the exact guarded task from a verified plan.
export async function probeBackend(directory, signal) {
  const root = await realpath(directory), { c, p } = await verifiedPlan(root, signal)
  const resource = await json(root, 'config/resource-plan.json', signal)
  if (canonical(resource.tasks.find(t => t.id === p.tasks.at(-1).id)) !== canonical(p.tasks.at(-1))) throw new Error('Probe task is not bound to the resource plan')
  const owned = JSON.parse(await readFile(await within(root, 'reports/rtl-flow/.run.lock'), 'utf8'))
  if (owned.owner_pid !== process.ppid) throw new Error('Backend probe must run under the foreground resource runner')
  const output = await backendPath(root, `${c.cache_dir}/probe`, true)
  await mkdir(output, { recursive: true })
  const request = { schema_version: 1, plan_identity: p.identity, platform: c.platform,
    orfs_root: p.resolved.mode === 'native' ? p.resolved.orfs_root : '/OpenROAD-flow-scripts',
    tools: p.resolved.mode === 'native' ? p.resolved.tools : {}, files: PLATFORM_FILES }
  await writeJSON(root, `${c.cache_dir}/probe/request.json`, request)
  const result = resolve(output, 'result.json')
  try { await unlink(result) } catch (e) { if (e.code !== 'ENOENT') throw e }
  let run, containerId
  if (p.resolved.mode === 'native') {
    run = await command(p.resolved.tools.python3, [PROBE, '--request', resolve(output, 'request.json'), '--output', result], signal, output, p.tasks.at(-1).estimate.wall_minutes * 60000)
  } else {
    const d = p.resolved.tools.docker, image = p.resolved.image.reference
    const actual = await command(d, ['image', 'inspect', image], signal)
    if (!actual.ok) throw new Error('Pinned Docker image unavailable after acquisition')
    const info = JSON.parse(actual.stdout)[0]
    if (info.Os !== 'linux' || archName(info.Architecture) !== p.resolved.image.platform.split('/')[1]) throw new Error('Pulled image platform mismatch')
    containerId = containerName(p)
    const bytes = Math.floor(p.tasks.at(-1).estimate.peak_memory_gib * GiB * 0.8)
    if (bytes < 128 * 1024 ** 2) throw new Error('Container probe needs an explicit budget of at least 160 MiB')
    const pluginRoot = dirname(dirname(PROBE))
    try {
      run = await command(d, ['run', '--rm', '--name', containerId, '--label', `rtl.flow.backend.identity=${p.identity}`, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--cpus', '1', '--memory', String(bytes), '--pids-limit', '128', '--tmpfs', '/tmp:rw,size=134217728', '-e', 'HOME=/tmp',
        '--platform', p.resolved.image.platform, '--mount', `type=bind,source=${pluginRoot},target=/rtl-plugin,readonly`,
        '--mount', `type=bind,source=${output},target=/rtl-report`, '--entrypoint', '/bin/bash', image, '-lc',
        '. /OpenROAD-flow-scripts/env.sh && exec python3 /rtl-plugin/src/backend-probe.py --request /rtl-report/request.json --output /rtl-report/result.json'], signal, undefined, p.tasks.at(-1).estimate.wall_minutes * 60000)
    } finally { await command(d, ['rm', '--force', containerId], undefined) }
    if (run.ok) { const report = JSON.parse(await readFile(result, 'utf8')); report.image_id = info.Id; await writeJSON(root, `${c.cache_dir}/probe/result.json`, report) }
  }
  process.stdout.write(run.stdout)
  process.stderr.write(run.stderr)
  if (!run.ok) throw new Error(`Backend minimum probe failed (native exit ${run.code}); inspect the original guarded log`)
  const report = JSON.parse(await readFile(result, 'utf8'))
  if (report.status !== 'pass' || report.plan_identity !== p.identity) throw new Error('Minimum probe did not produce a passing bound report')
  return { status: 'pass', report: `${c.cache_dir}/probe/result.json`, rtl_to_gds_verified: false }
}
