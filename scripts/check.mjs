import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const files = []

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) walk(path)
    else files.push(path)
  }
}

walk(join(root, 'lib'))
for (const path of files.filter((x) => /\.(?:js|mjs)$/.test(x))) {
  execFileSync(process.execPath, ['--check', path], { stdio: 'inherit' })
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (pkg.name !== 'dsh-fishboard-memory') throw new Error('package name mismatch')
if (!String(pkg.repository?.url || '').includes('hang27068/dsh-fishboard-memory')) {
  throw new Error('repository owner mismatch')
}

const publicFiles = files.concat([
  join(root, 'package.json'),
  join(root, 'README.md'),
  join(root, 'cordis.patch.yml'),
])
const forbidden = [
  /2706899763/g,
  /session-a64c0e43/g,
  /qq--115350239/g,
  /D:[\\/]QQBot/gi,
  /C:[\\/]Users[\\/]27068/gi,
]
for (const path of publicFiles) {
  const text = readFileSync(path, 'utf8')
  for (const pattern of forbidden) {
    pattern.lastIndex = 0
    if (pattern.test(text)) throw new Error(`private marker in ${relative(root, path)}: ${pattern}`)
  }
}

console.log(`OK: ${files.length} library files checked`)
