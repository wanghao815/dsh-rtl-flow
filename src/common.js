import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'

export const text = value => typeof value === 'string' && value.trim().length > 0
export const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
export const hashString = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export const unique = values => new Set(values).size === values.length
export const isRelative = value => text(value) && !value.includes('\\') && !value.includes('\0')
  && !value.startsWith('/') && !/^[A-Za-z]:/.test(value)
  && value.split('/').every(part => part && part !== '.' && part !== '..')
export const canonical = value => JSON.stringify(value, (_key, v) => plain(v)
  ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v)
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex')
export const label = value => text(value) ? value : '<invalid record>'

export async function within(root, path) {
  if (!isRelative(path)) throw new Error('Expected a project-relative file path')
  const full = await realpath(resolve(root, path))
  const rel = relative(root, full)
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error(`Path leaves project root: ${path}`)
  if (!(await stat(full)).isFile()) throw new Error(`Expected a regular file: ${path}`)
  return full
}
export async function smallRead(root, path, signal, maxBytes = 4 * 1024 * 1024) {
  const full = await within(root, path)
  if ((await stat(full)).size > maxBytes) throw new Error(`Metadata/report exceeds ${maxBytes} bytes: ${path}`)
  return readFile(full, { encoding: 'utf8', signal })
}
export async function sha256(path, signal) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk)
  return hash.digest('hex')
}
