#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFile, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { makeProject, scaffold, readGuide, TOPICS, planWork, migrateV1, designFingerprint, selectTopics } from '../src/core.js'
import { auditProject, writeScaffold, missingScaffold, captureCheckpoint, sha256 } from '../src/audit.js'
import { smallRead } from '../src/common.js'
import { inspectResources } from '../src/resources.js'
import { runTask } from '../src/runner.js'
import { parseReport } from '../src/reports.js'

const help = `rtl-flow 0.2.0 (Node >=24.9)
  guide <topic>                         Main stages and feature-specific guidance
  plan --config <options.json>           Preview new project files (no writes)
  init <new-dir> --config <options.json>  Explicitly create drafts, never overwrite
  adopt <dir> --config <options.json>    Preview only missing management files
  work <dir> [--entry modify --impact rtl,control]  Audit and plan reuse/reruns
  topics <dir>                          Select feature guidance
  audit <dir>                           Verify files, native metrics and delivery
  capture <dir> --config <spec.json>     Capture a role-based physical manifest to stdout
  parse <dir> --config <report-spec.json> Parse one original native report
  resources <dir>                       Probe actual device and remaining-work budget
  run <dir> --task <id>                 Explicit foreground, serial, guarded native task
  migrate <dir>                         Preview schema-v1 conversion; no evidence recertification
  hash <file> | overlay                 Digest or absolute development overlay
No command installs EDA tools, resumes paused work or publishes a package.
`
const controller = new AbortController()
process.once('SIGINT', () => controller.abort(new Error('Interrupted')))
process.once('SIGTERM', () => controller.abort(new Error('Terminated')))
const print = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n')
const readOptions = async path => {
  if (!path) throw new Error('This command requires --config')
  return JSON.parse(await readFile(path, { encoding: 'utf8', signal: controller.signal }))
}

try {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    config: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    entry: { type: 'string' }, impact: { type: 'string' }, task: { type: 'string' },
  } })
  const [command, argument] = positionals
  if (values.help || !command) process.stdout.write(help)
  else if (command === 'guide') process.stdout.write(await readGuide(argument, controller.signal))
  else if (command === 'overlay') {
    const { fileURLToPath } = await import('node:url')
    process.stdout.write(`- insert:\n    - id: rtl-flow\n      name: ${JSON.stringify(fileURLToPath(new URL('../src/index.js', import.meta.url)))}\n`)
  } else if (command === 'hash') {
    if (!argument) throw new Error('hash needs a file path')
    process.stdout.write((await sha256(resolve(argument), controller.signal)) + '\n')
  } else if (['plan', 'init', 'adopt'].includes(command)) {
    const options = await readOptions(values.config)
    const p = makeProject({ ...options, ...(command === 'adopt' ? { entry: 'adopt' } : {}) })
    const files = await scaffold(p, controller.signal)
    if (command !== 'plan' && !argument) throw new Error('This command needs a project directory')
    if (command === 'init' && p.work.entry !== 'new') throw new Error('init is only for new projects; use adopt/work for existing projects')
    print(command === 'plan' ? { project: p, files } : command === 'adopt' ? await missingScaffold(resolve(argument), files)
      : await writeScaffold(resolve(argument), files, controller.signal))
  } else if (['audit', 'work', 'topics', 'capture', 'parse', 'resources', 'run', 'migrate'].includes(command)) {
    if (!argument) throw new Error('This command needs a project directory')
    const root = await realpath(argument)
    if (command === 'audit') {
      const result = await auditProject(root, controller.signal); print(result); if (!result.ok) process.exitCode = 1
    } else if (command === 'resources') {
      const result = await inspectResources(root, controller.signal); print(result); if (!result.can_start) process.exitCode = 1
    } else if (command === 'run') {
      if (!values.task) throw new Error('run requires --task')
      const result = await runTask(root, values.task, controller.signal); print(result)
      if (result.execution_status !== 'completed') process.exitCode = 1
    } else if (command === 'capture') print(await captureCheckpoint(root, await readOptions(values.config), controller.signal))
    else if (command === 'parse') {
      const spec = await readOptions(values.config)
      const result = parseReport(await smallRead(root, spec.path, controller.signal, 32 * 1024 * 1024), spec, spec.check)
      print(result); if (result.status !== 'pass') process.exitCode = 1
    } else {
      const project = JSON.parse(await smallRead(root, 'rtl-flow.json', controller.signal))
      if (command === 'migrate') print(migrateV1(project))
      else if (command === 'topics') print({ topics: selectTopics(project), design_sha256: designFingerprint(project) })
      else {
        const assessment = await auditProject(root, controller.signal)
        const p = { ...project, work: { entry: values.entry ?? project.work.entry,
          impact: values.impact ? values.impact.split(',') : project.work.impact } }
        const result = planWork(p, assessment); print(result); if (!result.can_continue) process.exitCode = 1
      }
    }
  } else throw new Error('Unknown command; use --help')
} catch (error) {
  process.stderr.write(`rtl-flow: ${error.message}\n`)
  process.exitCode = controller.signal.aborted ? 130 : 2
}
