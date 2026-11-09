import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeProject, requirements, scaffold, designFingerprint } from '../src/core.js'
import { physicalRoles, isPhysical, isManual } from '../src/evidence.js'
import { writeScaffold, sha256 } from '../src/audit.js'

export const fresh = overrides => makeProject({ name: 'Unit fixture', top: 'dut', kind: 'generic', formal: false, ...overrides })
export const metrics = { checks_executed: 1, failures: 0, setup_wns_ns: 1, hold_wns_ns: 0.1,
  setup_tns_ns: 0, hold_tns_ns: 0, unconstrained_endpoints: 0, missing_parasitic_nets: 0,
  cap_violations: 0, slew_violations: 0, annotated_nets: 10, violations: 0, matched: true, devices: 10, ports: 4,
  vdd_shorts: 0, vss_shorts: 0, unconnected_power_pins: 0, solved_rails: 2, ir_drop_v: 0.01, ir_limit_v: 0.1,
  unrouted_nets: 0, unplaced_instances: 0, instances: 10, routed_nets: 10 }
export const reportSpec = { path: 'reports/native.json', parser: 'json-metrics', fields: Object.fromEntries(Object.keys(metrics).map(k => [k, `/metrics/${k}`])) }
export function allRecords(p) {
  const inputs = p.contracts.map(path => ({ path, sha256: 'a'.repeat(64) }))
  return requirements(p).flatMap(g => g.checks.map(c => {
    const r = { id: `${g.id}-${c.id}-${c.platform}`, gate: g.id, check: c.id, platform: c.platform, checkpoint: 'baseline',
      status: 'pass', scope: 'Synthetic unit-test inputs, no EDA signoff claim', summary: 'Declared unit invariant', limitations: [],
      design_sha256: designFingerprint(p), command: ['fixture-check'], exit_code: 0, expected_exit_code: 0,
      acceptance: { passed: true, criterion: 'Fixture invariant' }, inputs: structuredClone(inputs),
      artifacts: [{ path: 'reports/native.json', sha256: 'b'.repeat(64) }], source_manifest: 'flow/sources.f' }
    if (!isManual(r)) r.reports = [structuredClone(reportSpec)]
    if (isPhysical(r)) { r.checkpoint_manifest = `reports/${c.platform}-checkpoint.json`; r.checkpoint_sha256 = 'c'.repeat(64) }
    if (r.check === 'release') r.release_checkpoints = Object.fromEntries(p.platforms.map(v => [v.id, 'c'.repeat(64)]))
    return r
  }))
}

export async function fixture(overrides) {
  const p = { ...fresh(overrides), contract_status: 'confirmed' }, root = await mkdtemp(join(tmpdir(), 'rtl-flow-v2-'))
  await writeScaffold(root, await scaffold(p))
  const put = async (path, content) => {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n')
    return { path, sha256: await sha256(join(root, path)) }
  }
  await put('rtl/dut.sv', 'module dut; endmodule\n')
  await put('flow/sources.f', 'rtl/dut.sv\n')
  const artifact = await put('reports/native.json', { scope: 'synthetic parser fixture', metrics })
  const inputs = []
  for (const path of [...p.contracts, 'flow/sources.f', 'rtl/dut.sv']) inputs.push({ path, sha256: await sha256(join(root, path)) })
  const records = allRecords(p)
  const manifests = new Map()
  for (const platform of p.platforms) {
    const roles = [...new Set(records.filter(r => r.platform === platform.id && isPhysical(r)).flatMap(r => physicalRoles(r.check, platform.macros)))]
    const files = []
    for (const role of roles) files.push({ ...await put(`physical/${platform.id}/${role}.input`, `Synthetic fixture ${role}\n`), roles: [role] })
    const sourceInputs = inputs.map(f => ({ ...f, roles: [p.contracts.includes(f.path) ? 'contract' : f.path === 'flow/sources.f' ? 'source_manifest' : 'rtl'] }))
    const manifest = { schema_version: 2, id: 'baseline', platform: platform.id, design_sha256: designFingerprint(p), source_manifest: 'flow/sources.f', parameters: p.parameters, defines: p.defines, inputs: [...files, ...sourceInputs] }
    const file = await put(`reports/${platform.id}-checkpoint.json`, manifest)
    manifests.set(platform.id, { file, manifest })
  }
  for (const r of records) {
    r.inputs = structuredClone(inputs); r.artifacts = [structuredClone(artifact)]
    if (isPhysical(r)) {
      const m = manifests.get(r.platform)
      r.checkpoint_manifest = m.file.path; r.checkpoint_sha256 = m.file.sha256
      r.inputs.push(m.file, ...m.manifest.inputs.filter(f => !r.inputs.some(v => v.path === f.path)))
    }
    if (r.check === 'release') r.release_checkpoints = Object.fromEntries([...manifests].map(([id, m]) => [id, m.file.sha256]))
  }
  const save = async () => { await put('rtl-flow.json', p); await put('reports/rtl-flow/evidence.json', { schema_version: 2, records }) }
  await save()
  return { root, project: p, records, put, save, manifests }
}
