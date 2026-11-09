import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { text, plain, unique, isRelative, digest } from './common.js'
export { isRelative } from './common.js'
export { evaluate, validateRecord } from './evidence.js'

export const packageRoot = fileURLToPath(new URL('../', import.meta.url))
export const KINDS = ['generic', 'control', 'stream', 'memory', 'arithmetic', 'processor', 'interconnect', 'accelerator']
export const ENTRIES = ['new', 'adopt', 'modify', 'eco', 'resume']
export const FEATURES = ['arithmetic', 'stream', 'protocol', 'multiclock', 'memory', 'macros', 'formal']
export const TOPICS = ['workflow', 'architecture', 'toolchain', 'rtl', 'verification', 'physical', 'operations', ...FEATURES]
export const IMPACTS = {
  requirements: ['G0', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8'],
  toolchain: ['G1', 'G4', 'G5', 'G6', 'G7', 'G8'],
  reference: ['G2', 'G4', 'G5', 'G8'], control: ['G3', 'G4', 'G5', 'G6', 'G7', 'G8'],
  rtl: ['G4', 'G5', 'G6', 'G7', 'G8'], constraints: ['G4', 'G6', 'G7', 'G8'],
  physical: ['G6', 'G7', 'G8'], reporting: ['G8'],
}
export const STATUSES = ['pass', 'fail', 'blocked', 'timeout', 'unsupported', 'not_run', 'not_applicable', 'aborted']
export const GATES = [
  { id: 'G0', title: '规格、接口与预算', checks: ['spec_review'] },
  { id: 'G1', title: '工具与材料最小贯通', checks: ['toolchain'] },
  { id: 'G2', title: '参考模型、编码与数据', checks: ['reference'] },
  { id: 'G3', title: '控制、协议与周期骨架', checks: ['control'] },
  { id: 'G4', title: '关键单元 RTL 与实现探针', checks: ['leaf_function', 'leaf_structure'] },
  { id: 'G5', title: '层次集成与回归', checks: ['integration', 'regression'] },
  { id: 'G6', title: '综合、布局、CTS、布线与寄生', checks: ['implementation'] },
  { id: 'G7', title: '同版时序及物理检查', checks: ['sta', 'drc', 'lvs', 'antenna', 'power'] },
  { id: 'G8', title: '交付、接续与归档', checks: ['release'] },
]
const identifier = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
export const BUDGET_KEYS = ['wall_minutes', 'memory_gib', 'disk_gib', 'heavy_jobs', 'attempts', 'memory_reserve_gib', 'disk_reserve_gib']

export function validateProject(p) {
  const issues = []
  if (!plain(p)) return ['project must be an object']
  if (p.schema_version !== 2) issues.push('schema_version must be 2; migrate v1 explicitly, old evidence is not automatically recertified')
  if (!text(p.name) || /[\r\n\0]/.test(p.name)) issues.push('name must be a nonempty single line')
  if (!identifier(p.top)) issues.push('top must be a SystemVerilog identifier')
  if (!KINDS.includes(p.kind)) issues.push('invalid kind')
  if (!['rtl', 'asic'].includes(p.target)) issues.push('target must be rtl or asic')
  if (!['active', 'paused', 'archived'].includes(p.state)) issues.push('invalid lifecycle state')
  if (!['draft', 'confirmed'].includes(p.contract_status)) issues.push('invalid contract_status')
  if (!Array.isArray(p.platforms)) issues.push('platforms must be an array')
  else {
    if (p.target === 'asic' && !p.platforms.length) issues.push('asic target needs an explicitly chosen platform')
    if (!unique(p.platforms.map(v => v?.id))) issues.push('platform ids must be unique')
    for (const v of p.platforms) if (!plain(v) || !identifier(v.id) || v.id === 'common' || typeof v.macros !== 'boolean') issues.push('invalid platform id/macros')
  }
  if (!Array.isArray(p.features) || !p.features.every(f => FEATURES.includes(f)) || !unique(p.features)) issues.push('features must be unique supported feature names')
  if (!Array.isArray(p.contracts) || !p.contracts.length || !p.contracts.every(isRelative) || !unique(p.contracts)) issues.push('contracts must be unique project-relative paths')
  if (!plain(p.parameters) || !plain(p.defines)) issues.push('parameters and defines must be objects')
  if (!plain(p.work) || !ENTRIES.includes(p.work.entry) || !Array.isArray(p.work.impact) || !p.work.impact.every(v => Object.hasOwn(IMPACTS, v))) issues.push('work needs a supported entry and explicit impact list')
  if (!plain(p.budget)) issues.push('budget must be an object')
  else for (const key of BUDGET_KEYS) {
    const value = p.budget[key], reserve = key.endsWith('_reserve_gib')
    if (value !== null && (!Number.isFinite(value) || (reserve ? value < 0 : value <= 0))) issues.push(`budget.${key} must be ${reserve ? 'nonnegative' : 'positive'} or null`)
    if (['heavy_jobs', 'attempts'].includes(key) && value !== null && !Number.isSafeInteger(value)) issues.push(`budget.${key} must be an integer`)
  }
  if (!plain(p.delivery) || !['full', 'scoped', 'closeout'].includes(p.delivery.intent) || !Array.isArray(p.delivery.exclusions)) issues.push('invalid delivery declaration')
  else {
    if ((p.delivery.intent !== 'full' || p.delivery.exclusions.length) && (!plain(p.delivery.decision) || !text(p.delivery.decision.id) || !text(p.delivery.decision.reason))) issues.push('scope/closeout needs an explicit decision id and reason')
    if (p.delivery.intent === 'full' && p.delivery.exclusions.length) issues.push('full delivery cannot exclude checks')
    for (const e of p.delivery.exclusions) if (!plain(e) || !text(e.gate) || !text(e.check) || !text(e.platform) || !text(e.reason)) issues.push('each exclusion needs gate/check/platform/reason')
    if (!unique(p.delivery.exclusions.map(e => plain(e) ? [e.gate, e.check, e.platform].map(v => text(v) ? v : '<invalid>').join('/') : null))) issues.push('duplicate scope exclusions')
  }
  return issues
}

export function makeProject(options) {
  const { name, top, kind = 'generic', target = 'rtl', platforms = [], formal = true, multiclock = false, entry = 'new', impact = [] } = options
  const inferred = { control: ['protocol'], stream: ['stream'], memory: ['memory'], arithmetic: ['arithmetic'], interconnect: ['protocol'], processor: ['protocol'] }
  const features = [...new Set([...(options.features ?? inferred[kind] ?? []), ...(formal ? ['formal'] : []), ...(multiclock ? ['multiclock'] : []), ...(platforms.some(p => p?.macros) ? ['memory', 'macros'] : [])])].sort()
  const p = {
    schema_version: 2, name, top, kind, target, state: 'active', contract_status: 'draft',
    platforms, features, parameters: options.parameters ?? {}, defines: options.defines ?? {},
    contracts: options.contracts ?? ['docs/spec.md', 'docs/cycle_contract.md', 'docs/numeric_contract.md'], work: { entry, impact },
    budget: { wall_minutes: null, memory_gib: null, disk_gib: null, heavy_jobs: 1, attempts: null, memory_reserve_gib: null, disk_reserve_gib: null, ...options.budget },
    delivery: options.delivery ?? { intent: 'full', decision: null, exclusions: [] },
  }
  const issues = validateProject(p)
  if (issues.length) throw new Error(issues.join('; '))
  return p
}

export function designFingerprint(p) {
  return digest({ schema_version: 2, top: p.top, kind: p.kind, target: p.target, platforms: p.platforms,
    features: [...p.features].sort(), parameters: p.parameters, defines: p.defines, contracts: p.contracts })
}

export function requirements(p) {
  const issues = validateProject(p)
  if (issues.length) throw new Error(issues.join('; '))
  const physical = p.target === 'asic'
  return GATES.map((g, index) => {
    const checks = [], add = (id, platform = 'common') => checks.push({ id, platform })
    const applicable = physical || !['G6', 'G7'].includes(g.id)
    if (applicable) {
      if (['G6', 'G7'].includes(g.id)) for (const platform of p.platforms) for (const id of g.checks) add(id, platform.id)
      else for (const id of g.checks) add(g.id === 'G8' && p.delivery.intent === 'closeout' ? 'archive' : id)
      if (g.id === 'G1' && physical) for (const platform of p.platforms) add('physical_smoke', platform.id)
      if (g.id === 'G2' && p.features.includes('arithmetic')) add('numeric_reference')
      if (g.id === 'G3') {
        if (p.features.includes('multiclock')) add('cdc_rdc')
        if (p.features.some(f => ['stream', 'protocol'].includes(f))) add('protocol')
        if (p.features.includes('memory')) add('memory_interface')
      }
      if (g.id === 'G4') {
        if (p.features.includes('formal')) add('formal')
        if (p.features.includes('arithmetic')) add('numeric_directed')
        if (physical) for (const platform of p.platforms) add('leaf_timing', platform.id)
      }
      if (g.id === 'G5' && physical) for (const platform of p.platforms) if (platform.macros) add('macro_replay', platform.id)
    }
    return { ...g, applicable, checks, depends_on: g.id === 'G8' && p.delivery.intent === 'closeout' ? []
      : index ? [g.id === 'G8' && !physical ? 'G5' : GATES[index - 1].id] : [] }
  })
}

export function selectTopics(p) {
  return ['workflow', 'architecture', 'toolchain', 'rtl', 'verification', 'operations', ...(p.target === 'asic' ? ['physical'] : []), ...p.features]
}

export function planWork(p, assessment) {
  const gates = requirements(p).filter(g => g.applicable)
  const invalidated = p.work.entry === 'new' ? gates.map(g => g.id) : [...new Set(p.work.impact.flatMap(v => IMPACTS[v]))]
  const issues = []
  if (['modify', 'eco'].includes(p.work.entry) && !p.work.impact.length) issues.push('Classify the actual change impact before selecting reruns')
  if (!assessment || !Array.isArray(assessment.gates)) issues.push('Audit the existing baseline before reusing evidence')
  if (p.work.entry !== 'new' && assessment?.verification !== 'files-and-native-reports') issues.push('Existing evidence reuse requires a disk/native-report audit')
  const reuse = gates.filter(g => !invalidated.includes(g.id) && assessment?.gates?.find(v => v.id === g.id)?.status === 'pass').map(g => g.id)
  return { entry: p.work.entry, topics: selectTopics(p), reuse, invalidate: gates.filter(g => invalidated.includes(g.id)).map(g => g.id),
    execute: gates.filter(g => !reuse.includes(g.id)).map(g => g.id), issues,
    can_continue: p.state === 'active' && p.delivery.intent !== 'closeout' && !issues.length,
    note: 'Plan is advisory. Verify actual hashes and authority; a resume entry never clears a paused state.' }
}

export async function readGuide(topic, signal) {
  if (!TOPICS.includes(topic)) throw new Error('Unknown guidance topic')
  const path = topic === 'workflow' ? '../docs/core-workflow.md' : `../skills/rtl-design/references/${topic}.md`
  return readFile(new URL(path, import.meta.url), { encoding: 'utf8', signal })
}

export async function scaffold(p, signal) {
  const gates = requirements(p)
  const names = ['AGENTS.md', 'key_milestone.md', 'agent_ability_report.md', 'docs/spec.md', 'docs/cycle_contract.md', 'docs/numeric_contract.md',
    'docs/verification_plan.md', 'docs/physical_plan.md', 'docs/handoff.md', 'config/toolchain-lock.json', 'flow/sources.f', 'config/resource-plan.json']
  const files = await Promise.all(names.map(async path => ({ path,
    content: (await readFile(new URL(`../templates/project/${path}`, import.meta.url), { encoding: 'utf8', signal }))
      .replaceAll('{{PROJECT_NAME}}', p.name).replaceAll('{{TOP}}', p.top) })))
  files.push({ path: 'rtl-flow.json', content: JSON.stringify(p, null, 2) + '\n' })
  files.push({ path: 'reports/rtl-flow/evidence.json', content: '{"schema_version":2,"records":[]}\n' })
  files.push({ path: 'reports/rtl-flow/runs.json', content: '{"schema_version":2,"runs":[]}\n' })
  files.push({ path: 'TODO.md', content: `# ${p.name} 执行计划\n\n当前为草案，无设计/验证通过证据。工作入口 ${p.work.entry}；专题 ${p.features.join(', ')}。\n\n| 关口 | 目标 | 依赖 | 必需项 |\n| --- | --- | --- | --- |\n${gates.map(g => `| ${g.id} | ${g.title} | ${g.depends_on.join(', ') || '无'} | ${g.applicable ? g.checks.map(c => `${c.id}@${c.platform}`).join(', ') : '不适用：RTL-only'} |`).join('\n')}\n\n已有设计先审计并选择复用/失效范围。重任务先运行资源预检，剩余工作与探针更新 config/resource-plan.json。交付状态与技术通过分别记录。\n` })
  return files
}

export function migrateV1(p) {
  if (p?.schema_version !== 1) throw new Error('Expected a schema v1 project')
  const next = makeProject({ ...p, entry: 'adopt' })
  next.state = p.state; next.contract_status = p.contract_status
  return { project: next, note: 'Preview only. Reconcile baseline, features, budgets and old evidence explicitly; no files or reports were rewritten.' }
}
