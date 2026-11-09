import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parseReport } from '../src/reports.js'
import { metrics, reportSpec } from './helpers.js'

test('parsers read saved original cocotb, Yosys and Netgen reports', async () => {
  const cases = [['cocotb-good.log', 'cocotb', 'regression', 'pass'], ['cocotb-bad.log', 'cocotb', 'regression', 'fail'], ['yosys-good.log', 'yosys-check', 'leaf_structure', 'pass'], ['netgen-good.log', 'netgen', 'lvs', 'pass']]
  for (const [file, parser, check, expected] of cases) {
    const report = await readFile(new URL(`./fixtures/reports/${file}`, import.meta.url), 'utf8')
    assert.equal(parseReport(report, { parser }, check).status, expected)
  }
})

test('unknown, empty, skipped and malformed reports cannot pass', () => {
  assert.equal(parseReport('', { parser: 'cocotb' }, 'regression').status, 'unsupported')
  assert.equal(parseReport('TESTS=1 PASS=0 FAIL=0 SKIP=1', { parser: 'cocotb' }, 'regression').status, 'fail')
  assert.equal(parseReport('help/version only', { parser: 'yosys-check' }, 'leaf_structure').status, 'fail')
  assert.equal(parseReport('Netlists do not match.', { parser: 'netgen' }, 'lvs').status, 'fail')
  assert.equal(parseReport('SBY [x] DONE (TIMEOUT, rc=8)', { parser: 'sby' }, 'formal').status, 'fail')
  assert.equal(parseReport('SBY [x] DONE (PASS, rc=0)', { parser: 'sby' }, 'formal').status, 'pass')
  assert.equal(parseReport('PASS', { parser: 'marker', marker: 'PASS' }, 'sta').status, 'fail')
  assert.equal(parseReport('{bad}', reportSpec, 'sta').status, 'unsupported')
})

test('native metric mapping checks raw negative slack, electrical and model coverage', () => {
  const parse = (m, check = 'sta') => parseReport(JSON.stringify({ metrics: m }), reportSpec, check)
  assert.equal(parse(metrics).status, 'pass')
  assert.equal(parse({ ...metrics, hold_wns_ns: -0.000001 }).status, 'fail')
  assert.equal(parse({ ...metrics, cap_violations: 1 }).status, 'fail')
  assert.equal(parse({ ...metrics, annotated_nets: 0 }).status, 'fail')
  assert.equal(parse({ ...metrics, checks_executed: 0 }, 'antenna').status, 'fail')
  assert.equal(parse({ ...metrics, solved_rails: 1 }, 'power').status, 'fail')
  assert.equal(parse({ ...metrics, ir_drop_v: 0.2 }, 'power').status, 'fail')
  assert.equal(parse({ ...metrics, matched: false }, 'lvs').status, 'fail')
  assert.equal(parse({ ...metrics, violations: '0' }, 'drc').status, 'fail')
})

test('report families cannot replace physical criteria, and earlier cocotb failures remain visible', () => {
  for (const check of ['sta', 'leaf_timing', 'drc', 'antenna', 'power', 'implementation', 'physical_smoke']) {
    assert.equal(parseReport('Found and reported 0 problems.', { parser: 'yosys-check' }, check).status, 'fail')
    assert.equal(parseReport('TESTS=1 PASS=1 FAIL=0 SKIP=0', { parser: 'cocotb' }, check).status, 'fail')
  }
  const r = parseReport('TESTS=1 PASS=0 FAIL=1 SKIP=0\nTESTS=1 PASS=1 FAIL=0 SKIP=0', { parser: 'cocotb' }, 'regression')
  assert.equal(r.status, 'fail'); assert.equal(r.metrics.failed, 1); assert.equal(r.metrics.summaries, 2)
})
