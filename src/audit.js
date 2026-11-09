import { mkdir, realpath, writeFile, access } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { plain, text, hashString, isRelative, smallRead, within, sha256, canonical } from './common.js'
import { validateProject, designFingerprint } from './core.js'
import { evaluate, isPhysical, physicalRoles } from './evidence.js'
import { parseReport } from './reports.js'
export { sha256 } from './common.js'

export async function auditProject(directory, signal) {
  const root = await realpath(directory)
  const project = JSON.parse(await smallRead(root, 'rtl-flow.json', signal))
  const invalid = validateProject(project)
  if (invalid.length) return evaluate(project, [])
  const index = JSON.parse(await smallRead(root, 'reports/rtl-flow/evidence.json', signal))
  if (index?.schema_version !== 2 || !Array.isArray(index.records)) throw new Error('Evidence index needs schema_version=2 and records[]')
  const recordErrors = {}, parsed = [], cache = new Map()
  const checkedHash = async file => {
    if (!plain(file) || !isRelative(file.path) || !hashString(file.sha256)) throw new Error('Invalid file/hash declaration')
    const full = await within(root, file.path)
    if (!cache.has(full)) cache.set(full, await sha256(full, signal))
    if (cache.get(full) !== file.sha256) throw new Error(`Stale or corrupt file: ${file.path}`)
  }
  for (const [i, r] of index.records.entries()) {
    const errors = recordErrors[i] = []
    if (r?.status !== 'pass') continue
    const attempt = async fn => {
      try { signal?.throwIfAborted(); await fn() } catch (error) {
        if (signal?.aborted) throw error
        errors.push(error.message)
      }
    }
    const inputs = Array.isArray(r.inputs) ? r.inputs : [], artifacts = Array.isArray(r.artifacts) ? r.artifacts : []
    for (const file of [...inputs, ...artifacts]) await attempt(() => checkedHash(file))
    if (r.source_manifest) await attempt(async () => {
      const lines = (await smallRead(root, r.source_manifest, signal)).split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'))
      if (!lines.length) throw new Error('source manifest contains no RTL files')
      for (const path of [r.source_manifest, ...lines]) if (!isRelative(path) || !inputs.some(f => f?.path === path)) throw new Error(`input hash missing for source: ${text(path) ? path : '<invalid>'}`)
    })
    if (isPhysical(r)) await attempt(async () => {
      await checkedHash({ path: r.checkpoint_manifest, sha256: r.checkpoint_sha256 })
      const manifest = JSON.parse(await smallRead(root, r.checkpoint_manifest, signal))
      if (manifest?.schema_version !== 2 || manifest.design_sha256 !== designFingerprint(project) || manifest.platform !== r.platform || manifest.id !== r.checkpoint || !Array.isArray(manifest.inputs)) throw new Error('Checkpoint manifest design/platform/id mismatch')
      if (manifest.source_manifest !== r.source_manifest || canonical(manifest.parameters) !== canonical(project.parameters) || canonical(manifest.defines) !== canonical(project.defines)) throw new Error('Checkpoint source manifest/parameters/defines mismatch')
      for (const file of manifest.inputs) if (!plain(file) || !Array.isArray(file.roles) || !file.roles.length || !file.roles.every(text)) throw new Error('Each checkpoint input needs explicit roles[]')
      const platform = project.platforms.find(p => p.id === r.platform)
      for (const role of [...physicalRoles(r.check, platform?.macros), 'contract', 'source_manifest', 'rtl']) if (!manifest.inputs.some(f => f.roles.includes(role))) throw new Error(`Physical manifest missing input role: ${role}`)
      const names = manifest.inputs.map(f => f?.path)
      if (new Set(names).size !== names.length) throw new Error('Physical manifest contains duplicate paths')
      for (const file of manifest.inputs) {
        await checkedHash(file)
        if (!inputs.some(f => f?.path === file.path && f.sha256 === file.sha256)) throw new Error(`Evidence does not bind manifest input: ${file.path}`)
      }
      const sourcePaths = (await smallRead(root, r.source_manifest, signal)).split(/\r?\n/).map(v => v.trim()).filter(v => v && !v.startsWith('#'))
      for (const path of [...project.contracts, r.source_manifest, ...sourcePaths]) if (!manifest.inputs.some(f => f.path === path)) throw new Error(`Checkpoint source/contract closure missing: ${path}`)
      if (!inputs.some(f => f?.path === r.checkpoint_manifest && f.sha256 === r.checkpoint_sha256)) throw new Error('Evidence inputs must include the checkpoint manifest digest')
    })
    if (Array.isArray(r.reports)) for (const spec of r.reports) await attempt(async () => {
      if (!plain(spec) || !artifacts.some(f => f?.path === spec.path)) throw new Error('Unbound native report')
      const result = parseReport(await smallRead(root, spec.path, signal, 32 * 1024 * 1024), spec, r.check)
      parsed.push({ id: r.id, path: spec.path, parser: spec.parser, ...result })
      if (result.status !== 'pass') throw new Error(`Native report ${result.status}: ${result.issues.join('; ')}`)
    })
  }
  return { ...evaluate(project, index.records, { recordErrors, disk: true }), parsed_reports: parsed }
}

// Only missing management files are previewed for adoption; originals are never overwritten.
export async function missingScaffold(directory, files) {
  const root = await realpath(directory), missing = [], existing = []
  for (const file of files) {
    if (!isRelative(file.path)) throw new Error('Invalid scaffold path')
    try { await access(resolve(root, file.path)); existing.push(file.path) }
    catch (error) { if (error.code !== 'ENOENT') throw error; missing.push(file) }
  }
  return { files: missing, preserved: existing, action: 'preview-only; reconcile existing contracts and aliases before writing' }
}

export async function captureCheckpoint(directory, spec, signal) {
  const root = await realpath(directory)
  const p = JSON.parse(await smallRead(root, 'rtl-flow.json', signal))
  const issues = validateProject(p)
  if (issues.length) throw new Error(issues.join('; '))
  if (!plain(spec) || !text(spec.id) || !p.platforms.some(v => v.id === spec.platform) || !plain(spec.roles) || !isRelative(spec.source_manifest)) throw new Error('Checkpoint spec needs id, platform, source_manifest and roles {role:[paths]}')
  const inputs = new Map()
  const add = async (path, role) => {
    if (!inputs.has(path)) inputs.set(path, { path, sha256: await sha256(await within(root, path), signal), roles: [] })
    const file = inputs.get(path)
    if (!file.roles.includes(role)) file.roles.push(role)
  }
  for (const path of p.contracts) await add(path, 'contract')
  await add(spec.source_manifest, 'source_manifest')
  for (const path of (await smallRead(root, spec.source_manifest, signal)).split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'))) await add(path, 'rtl')
  if (![...inputs.values()].some(f => f.roles.includes('rtl'))) throw new Error('Cannot capture an empty RTL source manifest')
  for (const [role, paths] of Object.entries(spec.roles)) {
    if (!text(role) || !Array.isArray(paths) || !paths.length) throw new Error('Every input role needs an explicit nonempty file list')
    for (const path of paths) await add(path, role)
  }
  return { schema_version: 2, id: spec.id, platform: spec.platform, design_sha256: designFingerprint(p),
    parameters: p.parameters, defines: p.defines, source_manifest: spec.source_manifest,
    inputs: [...inputs.values()].sort((a, b) => a.path.localeCompare(b.path)) }
}

export async function writeScaffold(directory, files, signal) {
  await mkdir(directory, { recursive: true })
  const root = await realpath(directory)
  for (const file of files) {
    if (!isRelative(file.path)) throw new Error(`Invalid output path`)
    try { await access(resolve(root, file.path)); throw new Error(`Refusing to overwrite existing file: ${file.path}`) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    let parent = root
    for (const component of file.path.split('/').slice(0, -1)) {
      parent = resolve(parent, component)
      try { if (await realpath(parent) !== parent) throw new Error(`Refusing symlink output directory: ${parent}`) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
  for (const file of files) {
    signal?.throwIfAborted()
    const full = resolve(root, file.path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, file.content, { encoding: 'utf8', flag: 'wx', signal })
  }
  return { root, files: files.map(f => f.path), status: 'draft' }
}
