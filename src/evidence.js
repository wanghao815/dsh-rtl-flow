import { plain, text, hashString, isRelative, unique, label, digest } from './common.js'
import { requirements, validateProject, designFingerprint, STATUSES } from './core.js'
import { PARSERS, parserSupports } from './reports.js'

export const isPhysical = r => ['G6', 'G7'].includes(r?.gate) || ['leaf_timing', 'physical_smoke', 'macro_replay'].includes(r?.check)
export const isManual = r => ['spec_review', 'release', 'archive'].includes(r?.check)
export const evidenceKey = r => [r?.gate, r?.check, r?.platform].map(label).join('/')
export const physicalRoles = (check, macros = false) => [...new Set([
  ...(check === 'macro_replay' ? ['macro_model', 'macro_views']
    : ['sta', 'leaf_timing'].includes(check) ? ['netlist', 'sdc', 'parasitics', 'liberty', 'rc_rules', 'technology', 'database']
      : check === 'drc' ? ['layout', 'drc_rules', 'technology']
        : check === 'lvs' ? ['layout', 'netlist', 'lvs_rules', 'technology']
          : check === 'power' ? ['database', 'netlist', 'liberty', 'power_model', 'technology']
            : check === 'antenna' ? ['database', 'antenna_rules', 'antenna_models', 'technology']
              : ['netlist', 'sdc', 'liberty', 'database', 'layout', 'rc_rules', 'technology']),
  ...(macros ? ['macro_views', 'macro_model'] : []),
])]

export function validateRecord(r, p) {
  if (!plain(r)) return ['record must be an object']
  const issues = [], gates = requirements(p)
  for (const key of ['id', 'scope', 'checkpoint', 'summary']) if (!text(r[key])) issues.push(`${key} must be a nonempty string`)
  if (!gates.find(g => g.id === r.gate)?.checks.some(c => c.id === r.check && c.platform === r.platform)) issues.push('unknown gate/check/platform')
  if (!STATUSES.includes(r.status)) issues.push('invalid status')
  if (!Array.isArray(r.limitations) || !r.limitations.every(text)) issues.push('limitations must be a string array')
  for (const key of ['inputs', 'artifacts']) {
    if (!Array.isArray(r[key])) issues.push(`${key} must be an array`)
    else {
      if (!unique(r[key].map(f => f?.path))) issues.push(`duplicate ${key} path`)
      for (const f of r[key]) if (!plain(f) || !isRelative(f.path) || !hashString(f.sha256)) issues.push(`${key} need relative paths and string SHA-256`)
    }
  }
  if (r.status === 'pass') {
    if (!hashString(r.design_sha256) || r.design_sha256 !== designFingerprint(p)) issues.push('design configuration changed or unbound (top/parameters/features/platforms)')
    if (!Array.isArray(r.command) || !r.command.length || !r.command.every(text)) issues.push('pass needs actual command argv')
    if (!Number.isInteger(r.exit_code) || !Number.isInteger(r.expected_exit_code) || r.exit_code !== r.expected_exit_code || [130, 137, 143].includes(r.exit_code)) issues.push('pass needs a matching native exit, not an interrupted/killed process')
    if (!plain(r.acceptance) || r.acceptance.passed !== true || !text(r.acceptance.criterion)) issues.push('pass needs a met acceptance criterion')
    if (!Array.isArray(r.inputs) || !r.inputs.length || !Array.isArray(r.artifacts) || !r.artifacts.length) issues.push('pass needs hashed inputs/artifacts')
    if (Array.isArray(r.inputs) && p.contracts.some(path => !r.inputs.some(f => f?.path === path))) issues.push('missing current contract input')
    if (['G3', 'G4', 'G5', 'G6', 'G7'].includes(r.gate) && !isRelative(r.source_manifest)) issues.push('RTL checks need source_manifest')
    if (!isManual(r)) {
      if (!Array.isArray(r.reports) || !r.reports.length) issues.push('pass needs parsed native reports')
      else for (const report of r.reports) {
        if (!plain(report) || !isRelative(report.path) || !PARSERS.includes(report.parser)) issues.push('invalid report path/parser')
        else if (!parserSupports(report.parser, r.check)) issues.push(`report parser cannot certify ${r.check}`)
        if (!Array.isArray(r.artifacts) || !r.artifacts.some(f => f?.path === report?.path)) issues.push('native report must be a hashed artifact')
      }
    }
    if (isPhysical(r) && (!isRelative(r.checkpoint_manifest) || !hashString(r.checkpoint_sha256))) issues.push('physical evidence needs a hashed checkpoint manifest')
  }
  return issues
}

export function evaluate(p, records, options = {}) {
  const issues = validateProject(p)
  if (issues.length || !Array.isArray(records)) return { ok: false, technical_ok: false, delivery_ok: false, outcome: 'invalid', verification: 'invalid', issues: [...issues, ...(!Array.isArray(records) ? ['records must be an array'] : [])], gates: [], next: null }
  const gates = requirements(p).map(g => ({ ...g, status: g.applicable ? 'not_run' : 'not_applicable', checks: g.checks.map(c => ({ ...c, status: 'not_run', issues: [] })) }))
  const ids = new Map(), keys = new Map()
  for (const r of records) {
    if (plain(r) && text(r.id)) ids.set(r.id, (ids.get(r.id) ?? 0) + 1)
    const k = evidenceKey(r); keys.set(k, (keys.get(k) ?? 0) + 1)
  }
  const failures = new Map()
  for (const [index, r] of records.entries()) {
    const errors = validateRecord(r, p)
    if (plain(r) && ids.get(r.id) > 1) errors.push('duplicate record id')
    if (keys.get(evidenceKey(r)) > 1) errors.push('duplicate current evidence; preserve history outside this index')
    errors.push(...(options.recordErrors?.[index] ?? []))
    failures.set(index, errors)
    for (const error of errors) issues.push(`${label(r?.id)}: ${error}`)
  }
  // Physical labels are advisory; the digest of an explicit input-role manifest is the binding.
  for (const platform of p.platforms) {
    const selected = records.map((r, i) => ({ r, i })).filter(({ r }) => r?.platform === platform.id && ['G6', 'G7'].includes(r.gate) && r.status === 'pass')
    if (new Set(selected.map(({ r }) => r.checkpoint_sha256)).size > 1) for (const { i } of selected) failures.get(i).push('G6/G7 checkpoint manifest digest mismatch')
    const release = records.find(r => r?.check === 'release' && r.status === 'pass')
    if (p.target === 'asic' && release) {
      const impl = selected.find(({ r }) => r.gate === 'G6')?.r
      if (!impl || release.release_checkpoints?.[platform.id] !== impl.checkpoint_sha256) {
        const i = records.indexOf(release); failures.get(i).push('release must bind each selected physical manifest digest')
      }
    }
  }
  for (const [i, errors] of failures) for (const error of errors) {
    const message = `${label(records[i]?.id)}: ${error}`
    if (!issues.includes(message)) issues.push(message)
  }
  const exclusions = p.delivery.exclusions
  for (const exclusion of exclusions) {
    if (!gates.find(g => g.id === exclusion.gate)?.checks.some(c => c.id === exclusion.check && c.platform === exclusion.platform) || exclusion.gate === 'G8') issues.push('Exclusion does not name a valid non-delivery check')
  }
  for (const gate of gates) {
    if (!gate.applicable) continue
    for (const check of gate.checks) {
      const indexes = records.map((r, i) => ({ r, i })).filter(({ r }) => r?.gate === gate.id && r.check === check.id && r.platform === check.platform)
      const item = indexes[0]
      check.status = item ? failures.get(item.i).length ? 'invalid' : item.r.status : 'not_run'
      check.issues = item ? failures.get(item.i) : []
      check.excluded = p.delivery.intent === 'scoped' && exclusions.some(e => e.gate === gate.id && e.check === check.id && e.platform === check.platform)
    }
    const hasError = gate.checks.some(c => c.status === 'invalid')
    const own = gate.checks.every(c => c.status === 'pass' || c.excluded)
    const deps = gate.depends_on.every(id => ['pass', 'scoped'].includes(gates.find(g => g.id === id)?.status))
    gate.status = hasError ? 'invalid' : own && deps ? gate.checks.some(c => c.excluded) ? 'scoped' : 'pass' : 'blocked'
    if (gate.id === 'G0' && p.contract_status !== 'confirmed') gate.status = 'blocked'
    gate.missing = gate.checks.filter(c => c.status !== 'pass' && !c.excluded).map(c => `${c.id}@${c.platform}`)
  }
  const technical_ok = p.delivery.intent !== 'closeout' && gates.every(g => ['pass', 'not_applicable'].includes(g.status)) && !issues.length
  const delivered = gates.find(g => g.id === 'G8')?.status === 'pass'
  const delivery_ok = delivered && !issues.length && (p.delivery.intent === 'closeout' || gates.every(g => ['pass', 'scoped', 'not_applicable'].includes(g.status)))
  const outcome = p.state === 'paused' ? 'paused' : delivery_ok ? p.delivery.intent === 'full' ? 'full_verified' : p.delivery.intent === 'scoped' ? 'scoped_delivery' : 'experiment_closed' : 'incomplete'
  return { ok: delivery_ok, technical_ok, delivery_ok, outcome, verification: options.disk ? 'files-and-native-reports' : 'declarations-only',
    issues, gates, open_items: gates.flatMap(g => g.checks.filter(c => c.status !== 'pass').map(c => ({ gate: g.id, ...c }))),
    state: p.state, next: p.state !== 'active' || delivery_ok ? null : gates.find(g => g.applicable && !['pass', 'scoped'].includes(g.status))?.id ?? 'review_evidence',
    design_sha256: designFingerprint(p), note: 'A delivery outcome does not erase technical failures or certify foundry signoff.' }
}
