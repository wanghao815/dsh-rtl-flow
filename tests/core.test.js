import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { requirements, scaffold, evaluate, validateProject, validateRecord, TOPICS, readGuide, planWork, designFingerprint, migrateV1 } from '../src/core.js'
import { auditProject, writeScaffold, missingScaffold, captureCheckpoint } from '../src/audit.js'
import { fresh, allRecords, fixture, reportSpec } from './helpers.js'

test('features select check families; ASIC/RTL and macro platforms keep their scope', () => {
  const p = fresh({ target: 'asic', platforms: [{ id: 'techA', macros: true }, { id: 'techB', macros: false }], features: ['arithmetic', 'stream'], multiclock: true, formal: true })
  const req = requirements(p)
  assert.ok(req.find(g => g.id === 'G2').checks.some(c => c.id === 'numeric_reference'))
  assert.ok(req.find(g => g.id === 'G3').checks.some(c => c.id === 'cdc_rdc'))
  assert.ok(req.find(g => g.id === 'G3').checks.some(c => c.id === 'protocol'))
  assert.deepEqual(req.find(g => g.id === 'G5').checks.filter(c => c.id === 'macro_replay').map(c => c.platform), ['techA'])
  assert.equal(requirements(fresh()).find(g => g.id === 'G6').applicable, false)
})

test('drafts do not fabricate passing evidence; every routed topic exists', async () => {
  const p = fresh(), files = await scaffold(p)
  assert.equal(files.length, 16)
  assert.deepEqual(JSON.parse(files.find(f => f.path === 'reports/rtl-flow/evidence.json').content).records, [])
  assert.equal(evaluate(p, []).next, 'G0')
  assert.equal(evaluate({ ...p, state: 'paused' }, []).next, null)
  for (const topic of TOPICS) assert.ok((await readGuide(topic)).length > 400)
})

test('invalid projects and hostile JSON fields return errors without coercion exceptions', () => {
  assert.throws(() => fresh({ target: 'asic' }), /explicitly chosen/)
  assert.throws(() => fresh({ top: '../bad' }), /identifier/)
  assert.ok(validateProject({ ...fresh(), schema_version: 1 }).length)
  const p = { ...fresh(), contract_status: 'confirmed' }
  for (const field of ['id', 'gate', 'check', 'platform', 'checkpoint', 'scope', 'command']) {
    const records = allRecords(p); records[0][field] = { toString: null }
    assert.doesNotThrow(() => evaluate(p, records)); assert.equal(evaluate(p, records).ok, false)
  }
  for (const value of [null, [], 1, {}, { status: 'pass', inputs: 'wrong', artifacts: 'wrong' }]) assert.doesNotThrow(() => evaluate(p, [value]))
  const records = allRecords(p); records[0].inputs[0].sha256 = { toString: null }
  assert.equal(evaluate(p, records).ok, false)
})

test('invalid acceptance blocks its own gate, descendants and supplies a next step', () => {
  const p = { ...fresh(), contract_status: 'confirmed' }, records = allRecords(p)
  assert.equal(evaluate(p, records).ok, true)
  records[0].acceptance.passed = false
  const r = evaluate(p, records)
  assert.equal(r.ok, false); assert.equal(r.gates[0].status, 'invalid'); assert.equal(r.gates[5].status, 'blocked'); assert.equal(r.next, 'G0')
  assert.equal(evaluate(p, [...allRecords(p), allRecords(p)[0]]).ok, false)
})

test('design identity binds top, parameters and features, but not progress or lifecycle', () => {
  const p = { ...fresh(), contract_status: 'confirmed' }, records = allRecords(p)
  for (const change of [{ top: 'another_design' }, { parameters: { WIDTH: 99 } }, { features: ['arithmetic'] }]) assert.equal(evaluate({ ...p, ...change }, records).ok, false)
  assert.equal(designFingerprint(p), designFingerprint({ ...p, state: 'paused', work: { entry: 'resume', impact: [] } }))
})

test('native interrupted status cannot become an expected negative success', () => {
  const p = fresh(), r = allRecords(p)[0]
  r.exit_code = 1; r.expected_exit_code = 1; assert.deepEqual(validateRecord(r, p), [])
  r.exit_code = 143; r.expected_exit_code = 143; assert.ok(validateRecord(r, p).some(e => e.includes('interrupted')))
})

test('work modes reuse disk-audited prerequisites, invalidate impact and preserve pause', async () => {
  const f = await fixture(), audited = await auditProject(f.root)
  const p = { ...f.project, work: { entry: 'modify', impact: ['rtl'] } }
  const work = planWork(p, audited)
  assert.ok(work.reuse.includes('G1')); assert.ok(!work.reuse.includes('G5')); assert.ok(work.execute.includes('G4'))
  assert.equal(planWork({ ...p, state: 'paused', work: { entry: 'resume', impact: [] } }, audited).can_continue, false)
  assert.equal(planWork(p, evaluate(f.project, f.records)).can_continue, false)
  assert.equal(planWork({ ...p, work: { entry: 'eco', impact: [] } }, audited).can_continue, false)
})

test('disk staleness invalidates the actual gate, not only the global boolean', async () => {
  const f = await fixture()
  assert.equal((await auditProject(f.root)).ok, true)
  await f.put('rtl/dut.sv', 'module dut; wire changed; endmodule\n')
  const r = await auditProject(f.root)
  assert.equal(r.ok, false); assert.equal(r.gates.find(g => g.id === 'G3').status, 'invalid'); assert.equal(r.next, 'G0')
  await f.put('rtl/dut.sv', 'module dut; endmodule\n')
  f.project.top = 'another_design'; await f.save()
  assert.equal((await auditProject(f.root)).ok, false)
})

test('physical manifest digests and required roles reject label-only baseline mixing', async () => {
  const f = await fixture({ target: 'asic', platforms: [{ id: 'techA', macros: true }] })
  assert.equal((await auditProject(f.root)).ok, true)
  f.records.find(r => r.check === 'sta').checkpoint_sha256 = 'd'.repeat(64); await f.save()
  const r = await auditProject(f.root)
  assert.equal(r.ok, false); assert.notEqual(r.gates.find(g => g.id === 'G7').status, 'pass')
  assert.ok(r.issues.some(i => i.includes('digest mismatch')))
  const capture = await captureCheckpoint(f.root, { id: 'captured', platform: 'techA', source_manifest: 'flow/sources.f', roles: { sdc: ['physical/techA/sdc.input'] } })
  assert.ok(capture.inputs.some(f => f.roles.includes('rtl')))
  assert.ok(capture.inputs.some(f => f.roles.includes('sdc')))
})

test('raw report failure overrides model declared pass and blocks release', async () => {
  const f = await fixture()
  const bad = await f.put('reports/failing.log', 'TESTS=1 PASS=0 FAIL=1 SKIP=0\n')
  const r = f.records.find(r => r.check === 'regression')
  r.reports = [{ path: bad.path, parser: 'cocotb' }]; r.artifacts = [bad]; await f.save()
  const a = await auditProject(f.root)
  assert.equal(a.ok, false); assert.equal(a.gates.find(g => g.id === 'G5').status, 'invalid'); assert.equal(a.gates.find(g => g.id === 'G8').status, 'blocked')
})

test('STA cannot be certified by a valid but unrelated Yosys report', async () => {
  const f = await fixture({ target: 'asic', platforms: [{ id: 'techA', macros: false }] })
  const report = await f.put('reports/yosys.log', 'Found and reported 0 problems.\n')
  const r = f.records.find(r => r.check === 'sta')
  r.reports = [{ path: report.path, parser: 'yosys-check' }]; r.artifacts = [report]; await f.save()
  const a = await auditProject(f.root)
  assert.equal(a.ok, false); assert.equal(a.gates.find(g => g.id === 'G7').status, 'invalid')
})

test('scoped delivery and experiment closeout retain failed technical checks', async () => {
  const f = await fixture({ target: 'asic', platforms: [{ id: 'techA', macros: false }] })
  f.project.delivery = { intent: 'scoped', decision: { id: 'D1', reason: 'Agreed bounded experiment' }, exclusions: [{ gate: 'G7', check: 'antenna', platform: 'techA', reason: 'Model unavailable' }] }
  f.records.find(r => r.check === 'antenna').status = 'unsupported'; await f.save()
  let a = await auditProject(f.root)
  assert.equal(a.delivery_ok, true); assert.equal(a.technical_ok, false); assert.equal(a.outcome, 'scoped_delivery')
  assert.ok(a.open_items.some(c => c.id === 'antenna' && c.status === 'unsupported'))
  f.project.delivery = { intent: 'closeout', decision: { id: 'D2', reason: 'Stop at existing evidence' }, exclusions: [] }
  const archive = allRecords(f.project).find(r => r.check === 'archive')
  const old = f.records.findIndex(r => r.check === 'release')
  archive.inputs = f.records[old].inputs; archive.artifacts = f.records[old].artifacts
  f.records.splice(old, 1, archive); f.records.find(r => r.check === 'sta').status = 'fail'; await f.save()
  a = await auditProject(f.root)
  assert.equal(a.outcome, 'experiment_closed'); assert.equal(a.delivery_ok, true); assert.equal(a.technical_ok, false)
  assert.ok(a.open_items.some(c => c.id === 'sta' && c.status === 'fail'))
})

test('adoption only previews missing files; migration never recertifies old results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rtl-flow-adopt-'))
  await writeFile(join(root, 'AGENTS.md'), 'Keep existing rules')
  const files = await scaffold(fresh())
  const preview = await missingScaffold(root, files)
  assert.ok(preview.preserved.includes('AGENTS.md')); assert.ok(!preview.files.some(f => f.path === 'AGENTS.md'))
  await assert.rejects(writeScaffold(root, files), /overwrite/)
  assert.equal(await readFile(join(root, 'AGENTS.md'), 'utf8'), 'Keep existing rules')
  const migrated = migrateV1({ ...fresh(), schema_version: 1 })
  assert.equal(migrated.project.schema_version, 2); assert.equal(migrated.project.work.entry, 'adopt')
})

test('evidence cannot use files outside the project via symlinks', async () => {
  const f = await fixture(), outside = await mkdtemp(join(tmpdir(), 'rtl-flow-outside-'))
  await writeFile(join(outside, 'other.log'), 'external\n')
  await symlink(join(outside, 'other.log'), join(f.root, 'reports/escape.log'))
  f.records[0].artifacts = [{ path: 'reports/escape.log', sha256: 'f'.repeat(64) }]; await f.save()
  assert.ok((await auditProject(f.root)).issues.some(i => i.includes('leaves project root')))
})
