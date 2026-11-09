import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

test('FIFO: non-power-of-two wrap, full, simultaneous transfer, stalls, order and reset', async t => {
  const tool = process.env.RTL_FLOW_VERILATOR || 'verilator'
  const version = spawnSync(tool, ['--version'], { encoding: 'utf8' })
  if (version.error?.code === 'ENOENT') return t.skip('Verilator absent; core and Harness tests remain available')
  assert.equal(version.status, 0, version.stderr)
  const root = await mkdtemp(join(tmpdir(), 'rtl-flow-fifo-'))
  const fixture = fileURLToPath(new URL('./fixtures/fifo/', import.meta.url))
  const sources = ['stream_fifo.sv', 'tb.sv'].map(f => resolve(fixture, f))
  const run = (program, args) => spawnSync(program, args, { cwd: root, encoding: 'utf8', timeout: 120000 })
  const buildArgs = ['--binary', '--timing', '--assert', '--top-module', 'tb', '-j', '2', '--Mdir', join(root, 'obj'), ...sources]
  const compiled = run(tool, buildArgs)
  await writeFile(join(root, 'compile.log'), compiled.stdout + compiled.stderr)
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr)
  const passed = run(join(root, 'obj/Vtb'), [])
  await writeFile(join(root, 'simulation.log'), passed.stdout + passed.stderr)
  assert.equal(passed.status, 0, passed.stdout + passed.stderr)
  assert.match(passed.stdout, /FIFO_PASS/)
  // Break stored data without changing the oracle. The checker must detect an actual data mismatch.
  const broken = (await readFile(sources[0], 'utf8')).replace('mem[wp] <= in_data;', "mem[wp] <= in_data ^ 8'h01;")
  await writeFile(join(root, 'broken.sv'), broken)
  const negCompile = run(tool, ['--binary', '--timing', '--assert', '--top-module', 'tb', '-j', '2', '--Mdir', join(root, 'negative'), join(root, 'broken.sv'), sources[1]])
  await writeFile(join(root, 'negative-compile.log'), negCompile.stdout + negCompile.stderr)
  assert.equal(negCompile.status, 0, negCompile.stdout + negCompile.stderr)
  const rejected = run(join(root, 'negative/Vtb'), [])
  await writeFile(join(root, 'negative.log'), rejected.stdout + rejected.stderr)
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stdout + rejected.stderr, /data\/order mismatch/)
  t.diagnostic(`Verilator ${version.stdout.trim()}; logs and binaries: ${root}`)
})
