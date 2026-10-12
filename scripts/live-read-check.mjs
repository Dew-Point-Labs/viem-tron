// Manual, read-only probe of the built package against the public Shasta JSON-RPC endpoint.
// Not run in CI. Usage: pnpm build && pnpm check:live
import process from 'node:process'
import { http } from 'viem'
import { tronWebTransport } from '../dist/index.js'

const RPC = 'https://api.shasta.trongrid.io/jsonrpc'
const CHAIN_ID = 0x94a9059e
const CONTRACT = '0xe010048abee39457ddaa556ed782732ca80ab39c'
const MISSING_HASH = `0x${'0'.repeat(63)}1`

// A TronWeb with no account: enough for reads, and any wallet action would fail loudly.
const tronWeb = {
  defaultAddress: { hex: false, base58: false },
  address: {
    toHex: () => {
      throw new Error('stub')
    },
    fromHex: () => {
      throw new Error('stub')
    },
  },
  trx: {},
  transactionBuilder: {},
}
const rpc = http(RPC, { retryCount: 1, timeout: 15_000 })
const { request } = tronWebTransport(tronWeb, { rpc })({ chain: { id: CHAIN_ID } })

const call = (method, params = []) => request({ method, params })
const isQuantity = (value) => typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value)

const checks = [
  [
    'eth_chainId equals the configured chain id',
    async () => (await call('eth_chainId')) === '0x94a9059e',
  ],
  ['eth_blockNumber is a hex quantity', async () => isQuantity(await call('eth_blockNumber'))],
  [
    'eth_getCode of a known contract is non-empty',
    async () => {
      const code = await call('eth_getCode', [CONTRACT, 'latest'])
      return typeof code === 'string' && code.length > 2
    },
  ],
  [
    'eth_getTransactionByHash of an unknown hash is null',
    async () => (await call('eth_getTransactionByHash', [MISSING_HASH])) === null,
  ],
  [
    'eth_getTransactionReceipt of an unknown hash is null',
    async () => (await call('eth_getTransactionReceipt', [MISSING_HASH])) === null,
  ],
  [
    'eth_call without from is accepted (result or node revert)',
    async () => {
      try {
        await call('eth_call', [{ to: CONTRACT, data: '0x' }, 'latest'])
        return true
      } catch (error) {
        // A node revert is fine; a parameter error is not.
        return error?.name !== 'InvalidParamsRpcError' && error?.code !== -32602
      }
    },
  ],
  [
    'eth_getTransactionCount is refused locally',
    async () => {
      try {
        await call('eth_getTransactionCount', [CONTRACT, 'latest'])
        return false
      } catch (error) {
        return error?.name === 'MethodNotSupportedRpcError'
      }
    },
  ],
]

let failed = 0
for (const [label, run] of checks) {
  let ok = false
  let detail = ''
  try {
    ok = await run()
  } catch (error) {
    detail = ` (${error?.shortMessage ?? error?.message ?? error})`
  }
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail}`)
}
if (failed > 0) {
  console.log(`${failed} of ${checks.length} checks failed`)
  process.exit(1)
}
console.log(`all ${checks.length} checks passed`)
