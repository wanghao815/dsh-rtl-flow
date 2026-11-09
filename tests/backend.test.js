import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile, chmod, symlink, access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fixture } from './helpers.js'
import { backendDefaults, validateBackendConfig, initBackend, inspectBackend, planBackend, prepareBackend, checkBackend, resolveOfficialImage, PLATFORM_FILES } from '../src/backend.js'

const sha = value => 'sha256:' + createHash('sha256').update(value).digest('hex')
const image = 'openroad/orfs@sha256:' + 'a'.repeat(64)
const estimate = memory => ({ wall_minutes: 1, peak_memory_gib: memory, disk_gib: 0.1, basis: 'upper_bound', reason: 'Bounded local software protocol fixture including volume-sampling noise (observed 0.017 GiB); no real EDA/image download', evidence: [] })
const budget = { wall_minutes: 10, memory_gib: 1, disk_gib: 1, heavy_jobs: 1, attempts: 10, memory_reserve_gib: 0, disk_reserve_gib: 0 }
const toolScript = `#!/usr/bin/env python3
import pathlib,sys,shlex
name=pathlib.Path(sys.argv[0]).name
args=sys.argv[1:]
if '-version' in args or '-V' in args or '-v' in args or '--version' in args:
 print({'openroad':'OpenROAD fixture 1','yosys':'Yosys fixture 1','klayout':'KLayout fixture 1','make':'GNU Make 4.4'}[name]);sys.exit(0)
if name=='openroad':
 script=pathlib.Path(args[-1]).read_text()
 assert 'read_lef' in script and 'read_liberty' in script
 print('RTL_BACKEND_OPENROAD_READ_OK')
elif name=='yosys':
 path=shlex.split(args[args.index('-p')+1])[-1]
 if not pathlib.Path(path).read_text().startswith('library'):
  print('fixture Liberty rejected',file=sys.stderr);sys.exit(1)
 print('Imported 2 cell types from liberty file.')
elif name=='klayout':
 assert 'pya.Layout()' in pathlib.Path(args[-1]).read_text()
 print('RTL_BACKEND_GDS_READ_OK 2')
else: sys.exit(2)
`
const dockerScript = `#!/usr/bin/env python3
import json,os,pathlib,subprocess,sys
base=pathlib.Path(__file__).parent
args=sys.argv[1:]
with (base/'events').open('a') as log: log.write(json.dumps(args)+'\\n')
if args[0]=='info':
 print(json.dumps({'OSType':'linux','Architecture':os.environ.get('FAKE_DOCKER_ARCH','amd64'),'MemTotal':8*1024**3,'DockerRootDir':os.environ.get('FAKE_DOCKER_STORE',str(base/'store')),'ID':'fixture-engine','ServerVersion':'fixture-1'}))
elif args[:2]==['context','inspect']:
 print(json.dumps([{'Endpoints':{'docker':{'Host':os.environ.get('FAKE_DOCKER_ENDPOINT','unix:///fixture.sock')}}}]))
elif args[:2]==['image','inspect']:
 if not (base/'pulled').exists():sys.exit(1)
 print(json.dumps([{'Os':'linux','Architecture':'amd64','RepoDigests':['${image}'],'Id':'sha256:'+'b'*64}]))
elif args[0]=='pull':
 if (base/'reject-pull').exists():sys.exit(7)
 assert args[-1]=='${image}'
 (base/'pulled').write_text('local protocol fixture, no image downloaded')
elif args[0]=='run':
 assert args[args.index('--network')+1]=='none' and '--read-only' in args
 assert '--memory' in args and '--cpus' in args and '--pids-limit' in args
 if (base/'container.json').exists():
  print('container name already in use',file=sys.stderr);sys.exit(125)
 key,value=args[args.index('--label')+1].split('=',1)
 (base/'container.json').write_text(json.dumps({'Config':{'Labels':{key:value}}}))
 mounts=[args[i+1] for i,a in enumerate(args) if a=='--mount']
 source=lambda target:next(m.split('source=',1)[1].split(',target=',1)[0] for m in mounts if ',target='+target in m)
 output=pathlib.Path(source('/rtl-report')); probe=pathlib.Path(source('/rtl-probe.py'))
 assert probe.is_file() and len(mounts)==2
 request=json.loads((output/'request.json').read_text()); request['orfs_root']=os.environ['FAKE_ORFS_ROOT'];request['tools']=json.loads(os.environ['FAKE_BACKEND_TOOLS'])
 (output/'fixture-request.json').write_text(json.dumps(request))
 r=subprocess.run([sys.executable,str(probe),'--request',str(output/'fixture-request.json'),'--output',str(output/'result.json')])
 sys.exit(r.returncode)
elif args[0]=='rm':
 assert args[-1].startswith('rtl-backend-')
 (base/'container.json').unlink(missing_ok=True)
elif args[:2]==['container','inspect']:
 if not (base/'container.json').exists():
  print('No such container',file=sys.stderr);sys.exit(1)
 print('['+(base/'container.json').read_text()+']')
else:sys.exit(3)
`

async function environment(t, mode = 'native') {
  const f = await fixture({ budget })
  await initBackend(f.root)
  const orfs = resolve(f.root, 'provided-orfs'), toolsDir = resolve(f.root, 'fixture-tools')
  await mkdir(toolsDir)
  const tools = { python3: execFileSync('python3', ['-c', 'import os,sys;print(os.path.realpath(sys.executable))'], { encoding: 'utf8' }).trim() }
  for (const name of ['openroad', 'yosys', 'klayout', 'make']) {
    tools[name] = resolve(toolsDir, name); await writeFile(tools[name], toolScript); await chmod(tools[name], 0o755)
  }
  for (const path of Object.values(PLATFORM_FILES)) await f.put(`provided-orfs/flow/platforms/nangate45/${path}`, path.endsWith('.lib') ? 'library fixture\n' : 'Software platform fixture, not actual PDK\n')
  for (const path of ['env.sh', 'flow/Makefile', 'flow/util/docker_shell', 'flow/scripts/probe-input.tcl']) await f.put(`provided-orfs/${path}`, 'software fixture only\n')
  await f.put('provided-orfs/flow/platforms/nangate45/gds/cells.gds', 'Software GDS protocol fixture; no physical evidence\n')
  const config = { ...backendDefaults(), mode, network: 'offline', orfs_root: mode === 'native' ? orfs : null, tools,
    estimates: { acquire: estimate(0.1), probe: estimate(0.2) } }
  await f.put('config/backend.json', config)
  await f.put('config/resource-plan.json', { schema_version: 2, forecast_complete: true, prior_wall_minutes: 0, disk_spent_gib: 0, workspaces: ['.'], tasks: [] })
  if (mode === 'docker') {
    const docker = resolve(toolsDir, 'docker')
    await writeFile(docker, dockerScript); await chmod(docker, 0o755); await mkdir(resolve(toolsDir, 'store'))
    tools.docker = docker; config.tools = tools; config.docker.platform = 'linux/amd64'; config.network = 'allow'
    await f.put('config/backend.json', config)
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    const originalRoot = process.env.FAKE_ORFS_ROOT, originalTools = process.env.FAKE_BACKEND_TOOLS
    // Test-only local Docker protocol model. The production API exposes no platform override.
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'linux' })
    process.env.FAKE_ORFS_ROOT = orfs; process.env.FAKE_BACKEND_TOOLS = JSON.stringify(tools)
    t.after(() => {
      Object.defineProperty(process, 'platform', originalPlatform)
      if (originalRoot === undefined) delete process.env.FAKE_ORFS_ROOT; else process.env.FAKE_ORFS_ROOT = originalRoot
      if (originalTools === undefined) delete process.env.FAKE_BACKEND_TOOLS; else process.env.FAKE_BACKEND_TOOLS = originalTools
    })
  }
  const plan = await planBackend(f.root, undefined, { resolveImage: async () => ({ reference: image, requested: config.docker.image, platform: 'linux/amd64', digest: 'sha256:' + 'a'.repeat(64), compressed_bytes: 1024 }) })
  await f.put('config/backend-plan.json', plan)
  return { ...f, config, plan, orfs, tools, toolsDir }
}

test('backend is opt-in; offline missing setup never calls the network resolver or downloads', async () => {
  const f = await fixture({ budget })
  assert.equal((await inspectBackend(f.root)).status, 'not_selected')
  await initBackend(f.root)
  await assert.rejects(initBackend(f.root), e => e.code === 'EEXIST')
  const config = backendDefaults(); config.network = 'offline'
  await f.put('config/backend.json', config)
  const p = await planBackend(f.root, undefined, { resolveImage: () => { throw new Error('Offline mode attempted network') } })
  assert.equal(p.can_prepare, false); assert.equal(p.tasks.length, 0)
  assert.ok(p.issues.some(v => v.includes('Offline mode')))
  assert.equal(JSON.parse(await readFile(resolve(f.root, 'reports/rtl-flow/runs.json'), 'utf8')).runs.length, 0)
})

test('invalid image/path/type and symlink outputs are rejected without overwriting user files', async () => {
  const c = backendDefaults(); c.docker.image = {}; c.cache_dir = '../outside'
  assert.ok(validateBackendConfig(c).length >= 2)
  const f = await fixture({ budget }), outside = await fixture({ budget })
  await symlink(outside.root, resolve(f.root, '.local'))
  await assert.rejects(initBackend(f.root), /symbolic|leaves/)
  await assert.rejects(access(resolve(outside.root, 'rtl-backend')))
})

test('read-only download-cache recognition does not equate archives with installed tools', async () => {
  const f = await fixture({ budget }); await initBackend(f.root)
  await mkdir(resolve(f.root, 'download-cache'))
  await f.put('download-cache/OpenROAD-flow-scripts-' + 'a'.repeat(40) + '.tar.gz', 'archive presence fixture')
  const c = backendDefaults(); c.downloads_dir = resolve(f.root, 'download-cache'); c.network = 'offline'
  await f.put('config/backend.json', c)
  const inspected = await inspectBackend(f.root)
  assert.equal(inspected.archives.length, 1); assert.equal(inspected.archives[0].ready, false)
  assert.equal(inspected.native_complete, false)
})

test('native software fixture prepares once; tool, material and added-source drift invalidate identity', async t => {
  const f = await environment(t)
  assert.equal(f.plan.resolved.mode, 'native'); assert.equal(f.plan.can_prepare, true)
  const prepared = await prepareBackend(f.root)
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared)); assert.equal(prepared.rtl_to_gds_verified, false)
  assert.equal((await checkBackend(f.root)).status, 'ready')
  assert.equal((await prepareBackend(f.root)).reused, true)
  const ledger = JSON.parse(await readFile(resolve(f.root, 'reports/rtl-flow/runs.json'), 'utf8'))
  assert.equal(ledger.runs.length, 1)
  await f.put('provided-orfs/flow/scripts/new-input.tcl', 'changed closure\n')
  await assert.rejects(checkBackend(f.root), /input set changed/)
  await assert.rejects(prepareBackend(f.root), /changed since planning/)
})

test('unknown resource estimates do not start work or poison the existing resource plan', async t => {
  const f = await environment(t)
  f.config.estimates.probe = null; await f.put('config/backend.json', f.config)
  const p = await planBackend(f.root); await f.put('config/backend-plan.json', p)
  const before = await readFile(resolve(f.root, 'config/resource-plan.json'), 'utf8')
  const r = await prepareBackend(f.root)
  assert.equal(r.status, 'blocked'); assert.match(r.issues.join(' '), /estimate/)
  assert.equal(await readFile(resolve(f.root, 'config/resource-plan.json'), 'utf8'), before)
  assert.equal(JSON.parse(await readFile(resolve(f.root, 'reports/rtl-flow/runs.json'), 'utf8')).runs.length, 0)
})

test('bad Liberty is detected by the probe and no ready lock is issued', async t => {
  const f = await environment(t)
  await f.put('provided-orfs/flow/platforms/nangate45/lib/NangateOpenCellLibrary_typical.lib', 'BROKEN LIBERTY FIXTURE')
  await f.put('config/backend-plan.json', await planBackend(f.root))
  const result = await prepareBackend(f.root)
  assert.equal(result.status, 'failed', JSON.stringify(result))
  await assert.rejects(access(resolve(f.root, 'config/backend-lock.json')))
  const report = JSON.parse(await readFile(resolve(f.root, '.local/rtl-backend/probe/result.json'), 'utf8'))
  assert.equal(report.status, 'fail'); assert.match(report.error, /yosys-liberty-read/)
})

test('tampered backend tasks and changed executable inputs cannot launch', async t => {
  const f = await environment(t)
  const altered = structuredClone(f.plan); altered.tasks[0].argv = [process.execPath, '-e', 'process.exit(0)']
  await f.put('config/backend-plan.json', altered)
  await assert.rejects(prepareBackend(f.root), /modified/)
  await f.put('config/backend-plan.json', f.plan)
  await writeFile(f.tools.openroad, toolScript + '\n# new version\n')
  await assert.rejects(prepareBackend(f.root), /changed since planning/)
})

test('official OCI metadata is digest/architecture checked and uses no package-user credentials', async t => {
  const original = globalThis.fetch, calls = []
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, layers: [{ size: 1024 }] }))
  const manifestHash = sha(manifest)
  const index = Buffer.from(JSON.stringify({ schemaVersion: 2, manifests: [{ digest: manifestHash, platform: { os: 'linux', architecture: 'amd64' } }] }))
  globalThis.fetch = async (url, options) => {
    calls.push({ url, headers: options.headers })
    if (url.startsWith('https://auth.docker.io/token?')) return new Response(JSON.stringify({ token: 'anonymous-software-fixture' }))
    assert.ok(url.startsWith('https://registry-1.docker.io/v2/openroad/orfs/manifests/'))
    const body = url.endsWith('/latest') ? index : manifest
    return new Response(body, { headers: { 'docker-content-digest': sha(body) } })
  }
  t.after(() => { globalThis.fetch = original })
  const r = await resolveOfficialImage('openroad/orfs:latest', 'linux/amd64')
  assert.equal(r.reference, 'openroad/orfs@' + manifestHash); assert.equal(r.compressed_bytes, 1024)
  await assert.rejects(resolveOfficialImage('openroad/orfs:latest', 'linux/arm64'), /no linux\/arm64/)
  await assert.rejects(resolveOfficialImage('untrusted/installer:latest', 'linux/amd64'), /official/)
  assert.equal(calls[0].headers.Authorization, undefined)
  assert.equal(calls[1].headers.Authorization, 'Bearer anonymous-software-fixture')
  globalThis.fetch = async () => new Response(manifest, { headers: { 'docker-content-digest': 'sha256:' + '0'.repeat(64) } })
  await assert.rejects(resolveOfficialImage('openroad/orfs:latest', 'linux/amd64'), /token unavailable/)
})

test('local Docker protocol fixture acquires a pinned image, guards the probe and reuses the lock', async t => {
  const f = await environment(t, 'docker')
  assert.equal(f.plan.can_prepare, true, f.plan.issues.join('; '))
  assert.deepEqual(f.plan.tasks[0].argv.slice(-3), ['--platform', 'linux/amd64', image])
  const r = await prepareBackend(f.root)
  assert.equal(r.status, 'ready', JSON.stringify(r))
  assert.equal((await checkBackend(f.root)).status, 'ready')
  assert.equal((await prepareBackend(f.root)).reused, true)
  const events = (await readFile(resolve(f.toolsDir, 'events'), 'utf8')).trim().split('\n').map(v => JSON.parse(v))
  assert.equal(events.filter(v => v[0] === 'pull').length, 1)
  assert.equal(events.filter(v => v[0] === 'run').length, 1)
  assert.ok(events.some(v => v[0] === 'rm' && v.at(-1).startsWith('rtl-backend-')))
  const runtime = JSON.parse(await readFile(resolve(f.root, 'config/backend-runtime.json'), 'utf8'))
  assert.equal(runtime.image, image)
})

test('failed pinned-image acquisition preserves failure and does not start the container probe', async t => {
  const f = await environment(t, 'docker')
  await writeFile(resolve(f.toolsDir, 'reject-pull'), 'reject fixture acquisition')
  const r = await prepareBackend(f.root)
  assert.equal(r.status, 'failed'); assert.equal(r.run.exit_code, 7)
  const events = await readFile(resolve(f.toolsDir, 'events'), 'utf8')
  assert.equal(events.includes('["run"'), false)
  await assert.rejects(access(resolve(f.root, 'config/backend-lock.json')))
})

test('a separate Docker store filesystem is blocked rather than omitted from growth accounting', async t => {
  const f = await environment(t, 'docker')
  const previous = process.env.FAKE_DOCKER_STORE
  process.env.FAKE_DOCKER_STORE = '/dev'
  t.after(() => { if (previous === undefined) delete process.env.FAKE_DOCKER_STORE; else process.env.FAKE_DOCKER_STORE = previous })
  const p = await planBackend(f.root, undefined, { resolveImage: async () => ({ reference: image, platform: 'linux/amd64' }) })
  assert.equal(p.can_prepare, false)
  assert.ok(p.issues.some(i => i.includes('share the measured project filesystem')))
  await assert.rejects(prepareBackend(f.root), /changed|filesystem/)
  assert.equal((JSON.parse(await readFile(resolve(f.root, 'reports/rtl-flow/runs.json'), 'utf8'))).runs.length, 0)
})

test('explicit OCI index pin binds its selected architecture manifest', async t => {
  const f = await environment(t, 'docker'), index = 'sha256:' + 'c'.repeat(64)
  f.config.docker.image = 'openroad/orfs@' + index
  await f.put('config/backend.json', f.config)
  const p = await planBackend(f.root, undefined, { resolveImage: async () => ({ reference: image, index_digest: index, platform: 'linux/amd64' }) })
  await f.put('config/backend-plan.json', p)
  assert.equal((await prepareBackend(f.root)).status, 'ready')
})

test('a conflicting container without the ownership label is never removed', async t => {
  const f = await environment(t, 'docker')
  const path = resolve(f.toolsDir, 'container.json'), foreign = { Config: { Labels: { owner: 'another-project' } } }
  await writeFile(path, JSON.stringify(foreign))
  await assert.rejects(prepareBackend(f.root), /ownership label differs/)
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), foreign)
  const events = (await readFile(resolve(f.toolsDir, 'events'), 'utf8')).trim().split('\n').map(v => JSON.parse(v))
  assert.equal(events.some(v => v[0] === 'rm'), false)
  await assert.rejects(access(resolve(f.root, 'config/backend-lock.json')))
})
