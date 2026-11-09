// Developer smoke test: a real dsh profile's installed bundle, no model or Web server.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'

const { values } = parseArgs({ options: {
  'install-anchor': { type: 'string' }, home: { type: 'string' }, profile: { type: 'string' },
  workspace: { type: 'string' },
} })
for (const key of ['install-anchor', 'home', 'profile']) if (!values[key]) throw new Error(`Missing --${key}`)
const installAnchor = resolve(values['install-anchor'])
const home = resolve(values.home)
const requireFromHost = createRequire(installAnchor)
const load = async name => import(pathToFileURL(requireFromHost.resolve(name)).href)
const { loadProfile, createRuntimeResolution, PluginPackages } = await load('@deepseek-ai/dsh-app-boot')
const { Context } = await load('@deepseek-ai/cordis')
const profile = loadProfile('rtl-flow-check', values.profile, installAnchor, home)
if (profile.skippedBundles.length) throw new Error(JSON.stringify(profile.skippedBundles))
const layer = profile.layers.find(layer => layer.packageName === 'dsh-rtl-flow')
if (!layer) throw new Error('dsh-rtl-flow bundle is not present in this profile')
const resolution = await createRuntimeResolution({ installAnchor, profile, home })
const ctx = new Context()
const fibers = []
const mount = async (plugin, config) => {
  const fiber = ctx.plugin(plugin, config)
  fibers.push(fiber)
  await fiber.await()
  return fiber
}
try {
  await mount(PluginPackages, { resolution })
  const { SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
  const { ToolsService } = await load('@deepseek-ai/dsh-tools')
  await mount(SystemPrompt, {})
  await mount(ToolsService)
  await mount(await load('@deepseek-ai/dsh-tool-executor-native'))
  await mount(await import(pathToFileURL(resolve(layer.packageDir, 'src/index.js')).href), values.workspace ? { workspaceRoot: resolve(values.workspace) } : {})
  const call = async (id, name, args) => {
    const response = await ctx.tools.execute({ calls: [{ type: 'tool-call', id, name, arguments: JSON.stringify(args) }], signal: new AbortController().signal })
    const result = response.results[0].result
    if (result.isError) throw new Error(JSON.stringify(result))
    return result.value
  }
  const guide = await call('guide', 'rtl_guide', { topic: 'workflow' })
  const preview = await call('preview', 'rtl_scaffold', { project_name: 'Installed FIFO preview', top: 'fifo', kind: 'stream', target: 'rtl' })
  const audit = await call('audit', 'rtl_check_evidence', { project: preview.project, records: [] })
  const planned = await call('plan', 'rtl_plan_work', { project: preview.project, assessment: audit })
  const resources = values.workspace ? await call('resources', 'rtl_resource_check', {}) : null
  if (audit.ok || audit.verification !== 'declarations-only' || preview.files.length !== 16 || !planned.topics.includes('stream')) throw new Error('Incorrect installed tool behavior')
  if (resources && !(resources.device.total_memory_gib > 0 && resources.device.disks.length)) throw new Error('Installed resource tool did not inspect the real host')
  process.stdout.write(JSON.stringify({
    status: 'pass', profile: values.profile, runtime: 'DSH RuntimeResolution + PluginPackages + native tools',
    tool_names: ctx.tools.schemas().map(schema => schema.name), guide_bytes: Buffer.byteLength(guide.content),
    template_files: preview.files.length, draft_correctly_blocked: !audit.ok, model_api_calls: 0,
    resource_device_checked: Boolean(resources), resource_preflight_allowed: resources?.can_start ?? null,
  }, null, 2) + '\n')
} finally {
  for (const fiber of fibers.reverse()) await fiber.dispose()
}
