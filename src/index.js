import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { KINDS, TOPICS, ENTRIES, FEATURES, evaluate, makeProject, readGuide, scaffold, planWork } from './core.js'
import { inspectResources } from './resources.js'

export const name = 'rtl-flow'
export const inject = ['tools', 'systemPrompt']
export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  promptOrder: Schema.number().default(620),
  maxInputBytes: Schema.number().default(1048576),
  workspaceRoot: Schema.string().default(''),
})

export const GUIDANCE = `RTL engineering workflow (applies only to hardware design work):
Read rtl_guide(workflow), the canonical core workflow, then project instructions, TODO, decisions and actual evidence. Select new/adopt/modify/eco/resume using rtl_plan_work. Reuse unchanged audited prerequisites and rerun by actual impact. A resume entry never clears pause.
Use rtl_scaffold only for a NEW project's draft files; inspect its output and write through the host's normal file tools. Existing files must be preserved and changes reconciled deliberately. Generate the actual RTL and tests from this project's contracts with the host tools. Derive topology, arithmetic, pipeline and platform choices from the current requirements.
For an ASIC backend, inspect the existing environment and the user's backend choice first. ORFS setup is opt-in through CLI env init/inspect/plan/prepare/check and rtl_guide(toolchain). Reuse valid native tools or a pinned official ORFS image; prepare acquires missing assets only through the complete guarded resource plan. Offline mode must never contact download services. A source archive alone is not an installed tool, and environment readiness does not prove RTL-to-GDS.
Combine feature topics: arithmetic, stream, protocol, multiclock, memory, macros, formal. Work from contracts to representative leaf to hierarchy, verifying cycles, real outputs, independent references and negative controls. Match source/parameters across simulation/synthesis/formal.
Before heavy work, run rtl_resource_check for the configured project or the CLI resources command: inspect elapsed time + ALL remaining tasks, measured/upper-bound memory demand, actual device total/available memory and disk free space. Unknown/stale estimates or insufficient resources block launch. The explicit foreground CLI run command monitors its own process tree/time/disk and preserves native exit status; use host jobs to supervise it, never bypass a denial with an unguarded alternative.
Keep specification/proposal/assumption/evidence distinct. Bind project top/features/parameters and real source hashes. Physical evidence uses a hashed role-based checkpoint manifest, not a free-text label. CLI audit parses supported native reports and blocks invalid evidence and downstream gates. Declaration checks alone do not verify disk or reports.
Separate full verification, scoped delivery and experiment closeout from active/paused/archived lifecycle. Scope changes/closeout need explicit decisions. Keep all failed, incomplete and uncovered checks visible; archive completion is not technical acceptance.
Update project decisions, TODO and agent_ability_report with actual outcomes. Continue routine authorized work; return evidenced contract conflicts to the user. Honor agreed resource limits and handoff boundaries. Preserve failures and selected baselines at closeout.`

const jsonObject = { type: 'object', additionalProperties: true }
const render = (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]

export function apply(ctx, config) {
  if (!config.enabled) return
  if (!Number.isFinite(config.promptOrder)) throw new Error('promptOrder must be finite')
  if (!Number.isSafeInteger(config.maxInputBytes) || config.maxInputBytes <= 0) throw new Error('maxInputBytes must be a positive integer')
  const bounded = args => {
    if (Buffer.byteLength(JSON.stringify(args), 'utf8') > config.maxInputBytes) throw new Error('RTL tool input exceeds maxInputBytes; split the evidence set')
  }
  ctx.systemPrompt.section({ name: 'rtl-flow:guidance', order: config.promptOrder, text: GUIDANCE, interpolate: false })
  ctx.tools.register(defineTool({
    name: 'rtl_guide',
    description: 'Read stage-specific architecture, RTL, verification, ASIC implementation or operations guidance. Reads packaged reference text only.',
    parameters: { topic: { type: 'string', enum: TOPICS, required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        topic: { type: 'string', required: true }, content: { type: 'string', required: true },
      } }, render: (_args, value) => [{ type: 'text', text: value.content }],
    },
    async execute(args, exec) {
      bounded(args); exec.signal.throwIfAborted()
      return { topic: args.topic, content: await readGuide(args.topic, exec.signal) }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'rtl_scaffold',
    description: 'Preview a new generic RTL project: contracts, management documents, stage gates and evidence index. Returns files; does not write, generate the DUT, execute tools or resume a paused project.',
    parameters: {
      project_name: { type: 'string', required: true }, top: { type: 'string', required: true },
      kind: { type: 'string', enum: KINDS, required: true },
      target: { type: 'string', enum: ['rtl', 'asic'], required: true },
      platforms: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', required: true }, macros: { type: 'boolean', required: true },
      } } },
      formal: { type: 'boolean' }, multiclock: { type: 'boolean' },
      features: { type: 'array', items: { type: 'string', enum: FEATURES } },
      entry: { type: 'string', enum: ENTRIES },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      project: { ...jsonObject, required: true },
      files: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', required: true }, content: { type: 'string', required: true },
      } } },
    } }, render },
    async execute(args, exec) {
      bounded(args); exec.signal.throwIfAborted()
      const project = makeProject({ name: args.project_name, top: args.top, kind: args.kind, target: args.target,
        platforms: args.platforms ?? [], formal: args.formal ?? true, multiclock: args.multiclock ?? false,
        features: args.features, entry: args.entry ?? 'new' })
      return { project, files: await scaffold(project, exec.signal) }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'rtl_check_evidence',
    description: 'Validate project/evidence declarations, gate dependencies and checkpoint consistency. Supplied JSON is data. Does not read project files, validate SHA-256 against disk, run EDA or certify acceptance.',
    parameters: {
      project: { ...jsonObject, required: true },
      records: { type: 'array', items: jsonObject, required: true },
    },
    output: { schema: jsonObject, render },
    async execute(args, exec) {
      bounded(args); exec.signal.throwIfAborted()
      return evaluate(args.project, args.records)
    },
  }))
  ctx.tools.register(defineTool({
    name: 'rtl_plan_work',
    description: 'Plan new/adopt/modify/ECO/resume work from project features, explicit impact and an audit assessment. Preserves valid prerequisites; does not write or execute.',
    parameters: { project: { ...jsonObject, required: true }, assessment: { ...jsonObject, required: true } },
    output: { schema: jsonObject, render },
    async execute(args, exec) { bounded(args); exec.signal.throwIfAborted(); return planWork(args.project, args.assessment) },
  }))
  ctx.tools.register(defineTool({
    name: 'rtl_resource_check',
    description: 'Inspect actual device memory/disk and the configured project elapsed time, remaining tasks, estimates and budgets. Unknown/insufficient resources block execution. Reads only the configured workspace; starts no jobs.',
    parameters: {}, output: { schema: jsonObject, render },
    async execute(args, exec) {
      bounded(args); exec.signal.throwIfAborted()
      if (!config.workspaceRoot) throw new Error('Set workspaceRoot to the authorized project, or use rtl-flow resources via the host terminal')
      return inspectResources(config.workspaceRoot, exec.signal)
    },
  }))
}
