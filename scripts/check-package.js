import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { KINDS, makeProject, scaffold, TOPICS, readGuide } from '../src/core.js'
import { backendDefaults, validateBackendConfig } from '../src/backend.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
assert.match(await readFile(resolve(root, 'cordis.patch.yml'), 'utf8'), new RegExp(`name: ${pkg.name}`))
for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-system-prompt']) {
  assert.ok(pkg.peerDependencies[name] && pkg.devDependencies[name], `missing peer/dev: ${name}`)
}
assert.ok(!pkg.files.some(p => /^(reports|tests|node_modules|\.\.)/.test(p)))
assert.deepEqual(validateBackendConfig(backendDefaults()), [])
for (const path of ['src/backend.js', 'src/backend-probe.py', 'docs/backend-setup.md']) await stat(resolve(root, path))
for (const path of ['src/index.js', 'bin/rtl-flow.js', 'skills/rtl-design/SKILL.md', 'docs/core-workflow.md', 'docs/evidence.md', 'docs/resources.md', 'templates/project/config/resource-plan.json', 'LICENSE', 'README.md']) await stat(resolve(root, path))
for (const language of ['en', 'zh']) {
  const value = JSON.parse(await readFile(resolve(root, `locale/${language}.json`), 'utf8'))
  assert.ok(value.meta.title && value.meta.description)
}
for (const file of await readdir(resolve(root, 'examples'))) {
  const options = JSON.parse(await readFile(resolve(root, 'examples', file), 'utf8'))
  const files = await scaffold(makeProject(options))
  assert.ok(files.length >= 10)
  assert.ok(files.every(f => !f.content.includes('{{PROJECT_NAME}}') && !f.content.includes('{{TOP}}')))
}
for (const topic of TOPICS) assert.ok((await readGuide(topic)).length > 200, `missing/empty guide: ${topic}`)
assert.equal(await readGuide('workflow'), await readFile(resolve(root, 'docs/core-workflow.md'), 'utf8'))
for (const kind of KINDS) makeProject({ name: 'test', top: 'top', kind })
const walk = async directory => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'reports', '.git', '.local'].includes(entry.name)) continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) await walk(path)
    else if (entry.name.endsWith('.md')) {
      const content = await readFile(path, 'utf8')
      for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const link = match[1]
        if (/^(https?:|#)/.test(link)) continue
        const target = resolve(dirname(path), link.split('#')[0])
        assert.ok(!relative(root, target).startsWith('..'), `link outside distributable package: ${link}`)
        await stat(target)
      }
    }
  }
}
await walk(root)
process.stdout.write('PASS: bundle metadata, resources, examples, template substitutions and local Markdown links\n')
