import { plain, text } from './common.js'

export const PARSERS = ['cocotb', 'yosys-check', 'sby', 'netgen', 'marker', 'json-metrics']
export function parserSupports(parser, check) {
  if (!PARSERS.includes(parser)) return false
  if (check === 'toolchain') return true
  if (['sta', 'leaf_timing', 'drc', 'antenna', 'power', 'implementation', 'physical_smoke'].includes(check)) return parser === 'json-metrics'
  if (check === 'lvs') return ['json-metrics', 'netgen'].includes(parser)
  if (check === 'formal') return ['json-metrics', 'sby'].includes(parser)
  if (check === 'leaf_structure') return ['json-metrics', 'yosys-check'].includes(parser)
  return ['json-metrics', 'cocotb', 'marker'].includes(parser)
}
const number = value => typeof value === 'number' && Number.isFinite(value)
const pointer = (data, path) => {
  if (typeof path !== 'string' || !path.startsWith('/')) return undefined
  return path.slice(1).split('/').reduce((v, part) => v !== null && typeof v === 'object' && Object.hasOwn(v, part.replaceAll('~1', '/').replaceAll('~0', '~'))
    ? v[part.replaceAll('~1', '/').replaceAll('~0', '~')] : undefined, data)
}

// Metrics adapters consume the original native text/JSON, never a model-authored passed flag.
export function parseReport(content, spec, check) {
  const issues = [], metrics = {}
  if (!text(content) || !plain(spec) || !PARSERS.includes(spec.parser)) return { status: 'unsupported', metrics, issues: ['Unknown parser or empty native report'] }
  if (!parserSupports(spec.parser, check)) return { status: 'fail', metrics, issues: [`Parser ${spec.parser} cannot certify ${check}`] }
  const require = (condition, reason) => { if (!condition) issues.push(reason) }
  if (spec.parser === 'cocotb') {
    const matches = [...content.matchAll(/TESTS=(\d+)\s+PASS=(\d+)\s+FAIL=(\d+)\s+SKIP=(\d+)/g)]
    require(matches.length > 0, 'Missing cocotb native test summary')
    Object.assign(metrics, { summaries: matches.length, tests: 0, passed: 0, failed: 0, skipped: 0 })
    for (const m of matches) {
      metrics.tests += +m[1]; metrics.passed += +m[2]; metrics.failed += +m[3]; metrics.skipped += +m[4]
      require(+m[1] > 0 && +m[3] === 0 && +m[4] === 0 && +m[1] === +m[2], 'Native tests failed/skipped or counts inconsistent')
    }
  } else if (spec.parser === 'yosys-check') {
    const values = [...content.matchAll(/Found and reported (\d+) problems?\./g)].map(m => +m[1])
    require(values.length > 0, 'Missing Yosys check result')
    metrics.problems = values.length ? Math.max(...values) : null
    require(metrics.problems === 0 && !/^ERROR:/m.test(content), 'Yosys reports problems/errors')
  } else if (spec.parser === 'sby') {
    const results = [...content.matchAll(/DONE \((PASS|FAIL|UNKNOWN|ERROR|TIMEOUT),/g)]
    require(results.length > 0, 'Missing SBY native completion')
    metrics.result = results.at(-1)?.[1] ?? null
    require(metrics.result === 'PASS' && results.every(m => m[1] === 'PASS'), 'SBY proof did not pass')
  } else if (spec.parser === 'netgen') {
    require(/(?:Final result:\s*)?Circuits match uniquely\./i.test(content), 'Missing unique Netgen match')
    require(!/(?:do not match|do NOT match|mismatch|property errors were found|failed to match)/i.test(content), 'Netgen reports mismatch/property errors')
    metrics.matched = issues.length === 0
  } else if (spec.parser === 'marker') {
    require(!['sta', 'leaf_timing', 'drc', 'lvs', 'antenna', 'power', 'implementation'].includes(check), 'A marker cannot certify a physical check')
    require(text(spec.marker) && content.split(/\r?\n/).includes(spec.marker), 'Missing predeclared exact-line success marker')
    require(!/(?:Assertion failed|\$fatal|%Error|Traceback \(most recent call last\))/.test(content), 'Native assertion/infrastructure error found')
    metrics.marker_found = issues.length === 0
  } else {
    let data
    try { data = JSON.parse(content) } catch { return { status: 'unsupported', metrics, issues: ['Native report is not valid JSON'] } }
    require(plain(spec.fields) && Object.keys(spec.fields).length > 0, 'JSON parser needs explicit metric JSON pointers')
    if (plain(spec.fields)) for (const [key, path] of Object.entries(spec.fields)) {
      const value = pointer(data, path)
      if (value === undefined) issues.push(`Missing native metric: ${key}`)
      else metrics[key] = value
    }
    const zero = keys => keys.forEach(key => require(number(metrics[key]) && metrics[key] === 0, `${key} must be native numeric zero`))
    const positive = keys => keys.forEach(key => require(number(metrics[key]) && metrics[key] > 0, `${key} must show actual nonempty coverage`))
    if (['sta', 'leaf_timing'].includes(check)) {
      for (const key of ['setup_wns_ns', 'hold_wns_ns']) require(number(metrics[key]) && metrics[key] >= 0, `${key} is negative or missing`)
      zero(['setup_tns_ns', 'hold_tns_ns', 'unconstrained_endpoints', 'missing_parasitic_nets', 'cap_violations', 'slew_violations'])
      positive(['annotated_nets'])
    } else if (['drc', 'antenna'].includes(check)) {
      zero(['violations']); positive(['checks_executed'])
    } else if (check === 'lvs') {
      require(metrics.matched === true, 'LVS must match'); positive(['devices', 'ports'])
    } else if (check === 'power') {
      zero(['vdd_shorts', 'vss_shorts', 'unconnected_power_pins']); positive(['solved_rails'])
      require(metrics.solved_rails === 2, 'Both rails must be solved')
      for (const key of ['ir_drop_v', 'ir_limit_v']) require(number(metrics[key]) && metrics[key] >= 0, `Missing ${key}`)
      require(metrics.ir_drop_v <= metrics.ir_limit_v, 'IR exceeds the declared limit')
    } else if (check === 'implementation' || check === 'physical_smoke') {
      zero(['unrouted_nets', 'unplaced_instances']); positive(['instances', 'routed_nets'])
    } else {
      positive(['checks_executed']); zero(['failures'])
    }
  }
  return { status: issues.length ? 'fail' : 'pass', metrics, issues }
}
