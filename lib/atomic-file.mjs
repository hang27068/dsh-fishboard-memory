import fs from 'node:fs'
import { randomUUID } from 'node:crypto'

// Same-directory staging keeps a failed or interrupted write away from the live
// JSON file. This is one-file replacement, not a multi-process transaction.
export function writeFileAtomicSync(target, text) {
  const staged = target + '.' + randomUUID() + '.tmp'
  let mode = 0o600
  try { mode = fs.statSync(target).mode & 0o777 }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  let descriptor
  let created = false
  let committed = false
  try {
    descriptor = fs.openSync(staged, 'wx', mode)
    created = true
    if (process.platform !== 'win32') fs.fchmodSync(descriptor, mode)
    fs.writeFileSync(descriptor, text, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(staged, target)
    committed = true
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch { /* preserve the original failure */ }
    }
    if (created && !committed) {
      try { fs.rmSync(staged, { force: true }) } catch { /* caller still receives the write failure */ }
    }
  }
}
