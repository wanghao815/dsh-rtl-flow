import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolsService } from '@deepseek-ai/dsh-tools'
import * as native from '@deepseek-ai/dsh-tool-executor-native'
import * as plugin from '../src/index.js'
import { fixture } from './helpers.js'

async function runtime(t, config = {}) {
  const ctx = new Context()
  const prompt = ctx.plugin(SystemPrompt, {})
  await prompt.await()
  const tools = ctx.plugin(ToolsService)
  await tools.await()
  const executor = ctx.plugin(native)
  await executor.await()
  const fiber = ctx.plugin(plugin, config)
  await fiber.await()
  t.after(async () => { await fiber.dispose(); await executor.dispose(); await tools.dispose(); await prompt.dispose() })
  let id = 0
  const invoke = async (name, args, signal = new AbortController().signal) => {
    const result = await ctx.tools.execute({ calls: [{ type: 'tool-call', id: `rtl-test-${++id}`, name, arguments: JSON.stringify(args) }], signal })
    return result.results[0].result
  }
  return { ctx, fiber, invoke }
}

test('actual Harness registers schemas, canonical tool values and cleans up on unload', async t => {
  const { ctx, fiber, invoke } = await runtime(t)
  assert.deepEqual(ctx.tools.schemas().map(s => s.name).sort(), ['rtl_check_evidence', 'rtl_guide', 'rtl_plan_work', 'rtl_resource_check', 'rtl_scaffold'])
  const guide = await invoke('rtl_guide', { topic: 'architecture' })
  assert.equal(guide.isError, false)
  assert.ok(guide.value.content.includes('FIFO'))
  const result = await invoke('rtl_scaffold', { project_name: 'APB example', top: 'apb_regs', kind: 'control', target: 'asic', platforms: [{ id: 'techA', macros: false }] })
  assert.equal(result.isError, false)
  assert.equal(result.value.project.top, 'apb_regs')
  assert.equal(result.value.files.some(f => f.path === 'rtl-flow.json'), true)
  assert.ok(Object.isFrozen(result.value))
  const checked = await invoke('rtl_check_evidence', { project: result.value.project, records: [] })
  assert.equal(checked.isError, false)
  assert.equal(checked.value.ok, false)
  assert.equal(checked.value.verification, 'declarations-only')
  const planned = await invoke('rtl_plan_work', { project: result.value.project, assessment: checked.value })
  assert.equal(planned.isError, false)
  assert.ok(planned.value.topics.includes('protocol'))
  assert.equal((await invoke('rtl_resource_check', {})).isError, true)
  await fiber.dispose()
  assert.equal(ctx.tools.schemas().length, 0)
  assert.equal((await ctx.systemPrompt.assemble({})).sections.some(s => s.name === 'rtl-flow:guidance'), false)
})

test('actual execution pipeline rejects invalid input, over-budget input and cancellation', async t => {
  const { invoke } = await runtime(t, { maxInputBytes: 512 })
  assert.equal((await invoke('rtl_guide', { topic: '../../outside' })).isError, true)
  assert.equal((await invoke('rtl_scaffold', { project_name: 'x', top: 'foo' })).isError, true)
  assert.equal((await invoke('rtl_scaffold', { project_name: 'x', top: 'foo', kind: 'control', target: 'asic' })).isError, true)
  assert.equal((await invoke('rtl_guide', { topic: 'rtl', extra: 'x'.repeat(1024) })).isError, true)
  const c = new AbortController(); c.abort()
  assert.equal((await invoke('rtl_guide', { topic: 'rtl' }, c.signal)).isError, true)
})

test('disable and config reload preserve host lifecycle without duplicate tools', async t => {
  const { ctx, fiber } = await runtime(t)
  await fiber.update({ enabled: false })
  assert.equal(ctx.tools.schemas().length, 0)
  await fiber.update({ enabled: true })
  assert.equal(ctx.tools.schemas().length, 5)
})

test('configured Harness resource tool reads the actual project and host without launching a task', async t => {
  const f = await fixture()
  const { invoke } = await runtime(t, { workspaceRoot: f.root })
  const r = await invoke('rtl_resource_check', {})
  assert.equal(r.isError, false); assert.equal(r.value.can_start, false)
  assert.ok(r.value.device.total_memory_gib > 0)
  assert.ok(r.value.issues.some(i => i.includes('estimated') || i.includes('undecided')))
  assert.equal(r.value.ledger.runs.length, 0)
})
