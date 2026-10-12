import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const bin = (name) => join(root, 'node_modules', '.bin', name)
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' })
const NAME = '@dewpointlabs/viem-tron'
const tmp = mkdtempSync(join(tmpdir(), 'viem-tron-check-'))

try {
  const packDir = join(tmp, 'pack')
  mkdirSync(packDir)
  run('pnpm', ['pack', '--pack-destination', packDir], root)
  const tarball = join(packDir, readdirSync(packDir).find((f) => f.endsWith('.tgz')) ?? '')

  const files = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    .split('\n')
    .filter((f) => f && !f.endsWith('/'))
    .map((f) => f.replace(/^package\//, ''))
  const allowed = (f) =>
    ['package.json', 'README.md', 'CHANGELOG.md'].includes(f) || f.startsWith('dist/')
  const extra = files.filter((f) => !allowed(f))
  if (extra.length > 0) throw new Error(`unexpected files in tarball: ${extra.join(', ')}`)

  const app = join(tmp, 'app')
  mkdirSync(app)
  writeFileSync(join(app, 'package.json'), '{"name":"consumer","private":true}')
  run('npm', ['install', '--no-audit', '--no-fund', tarball, 'viem@2.21.55'], app)

  // Construct a real transport from the installed package, with a TronWeb that is never called.
  const check = `
    const tronWeb = { defaultAddress: { hex: false, base58: false }, address: {}, trx: {}, transactionBuilder: {} }
    const transport = m.tronWebTransport(tronWeb, { rpc: 'http://localhost' })({ chain: { id: 1 } })
    if (transport.config.type !== 'tronWeb' || transport.value.tronWeb !== tronWeb) process.exit(1)
    if (typeof m.BroadcastIndeterminateError !== 'function') process.exit(1)
  `
  writeFileSync(join(app, 'c.cjs'), `const m = require('${NAME}'); ${check}`)
  writeFileSync(join(app, 'e.mjs'), `const m = await import('${NAME}'); ${check}`)
  run('node', ['c.cjs'], app)
  run('node', ['e.mjs'], app)

  run(bin('publint'), ['run', '--strict', '--pack', 'pnpm'], root)
  run(bin('attw'), ['--pack', root], root)
  console.log(`PASS: ${files.length} files in tarball, CJS+ESM import ok, publint ok, attw ok`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
