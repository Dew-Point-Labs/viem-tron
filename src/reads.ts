import { to0x, walletAddress } from './address.js'
import { invalidParams } from './errors.js'
import { type TronWebLike, isRecord } from './types.js'

/** Methods answered by the JSON-RPC endpoint. Everything else is local or unsupported. */
export const FORWARDED_METHODS: ReadonlySet<string> = new Set([
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getBalance',
  'eth_call',
  'eth_estimateGas',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getLogs',
  'eth_gasPrice',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
])

/** Params of `eth_call` / `eth_estimateGas` with addresses in the 0x form the node expects. */
export function normalizeCallParams(tronWeb: TronWebLike, params: unknown): unknown {
  if (!Array.isArray(params) || !isRecord(params[0])) return params
  const call = { ...params[0] }
  for (const key of ['to', 'from']) {
    if (call[key] == null) continue
    const address = to0x(tronWeb, call[key])
    if (!address) throw invalidParams(`\`${key}\` is not a valid address.`)
    call[key] = address
  }
  // Contracts that check `msg.sender` simulate differently without the real sender.
  call.from ??= walletAddress(tronWeb)
  if (call.from === undefined) delete call.from
  return [call, ...(params.slice(1) as unknown[])]
}

/** Maps java-tron's `"0x"` placeholders of a not-yet-included transaction to standard values. */
export function normalizeReadResult(method: string, result: unknown): unknown {
  if (!isRecord(result)) return result
  if (method === 'eth_getTransactionByHash') {
    const transaction = { ...result }
    for (const key of ['blockHash', 'blockNumber', 'transactionIndex'])
      if (transaction[key] === '0x') transaction[key] = null
    if (transaction.gasPrice === '0x') transaction.gasPrice = '0x0'
    return transaction
  }
  if (method === 'eth_getTransactionReceipt') {
    const pending = (key: string) => result[key] == null || result[key] === '0x'
    return ['blockHash', 'blockNumber', 'status'].some(pending) ? null : result
  }
  return result
}
