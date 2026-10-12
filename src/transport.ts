import {
  BaseError,
  type EIP1193RequestFn,
  MethodNotSupportedRpcError,
  UrlRequiredError,
  createTransport,
  http,
  numberToHex,
} from 'viem'
import { walletAddress } from './address.js'
import { FORWARDED_METHODS, normalizeCallParams, normalizeReadResult } from './reads.js'
import { sendTransaction } from './sendTransaction.js'
import { signTypedData } from './signTypedData.js'
import type { TronWebLike, TronWebTransport, TronWebTransportConfig } from './types.js'

/**
 * A viem transport for Tron. Wallet actions (`eth_sendTransaction`, `eth_signTypedData_v4`,
 * `eth_accounts`) go through the given TronWeb instance and are never retried; reads are
 * forwarded to a Tron JSON-RPC endpoint. Amounts (`value`, `feeLimit`) are in SUN.
 *
 * @example
 * const client = createWalletClient({ chain: tron, transport: tronWebTransport(tronWeb) })
 */
export function tronWebTransport(
  tronWeb: TronWebLike,
  config: TronWebTransportConfig = {},
): TronWebTransport {
  const { rpc, feeLimit = 300_000_000, key = 'tronWeb', name = 'TronWeb' } = config
  const { retryCount, retryDelay, timeout } = config
  if (!Number.isSafeInteger(feeLimit) || feeLimit <= 0)
    throw new BaseError('`feeLimit` must be a positive safe integer, in SUN.')

  return ({ chain }) => {
    if (!chain)
      throw new BaseError('A `chain` is required: `eth_chainId` is answered from `chain.id`.')
    // Null-safe: plain-JavaScript callers pass a chain that is only `{ id }`.
    const { rpcUrls } = chain as { rpcUrls?: { default?: { http?: readonly string[] } } }
    const endpoint = rpc ?? rpcUrls?.default?.http?.[0]
    if (!endpoint) throw new UrlRequiredError()
    const read = (
      typeof endpoint === 'string' ? http(endpoint, { retryCount, retryDelay, timeout }) : endpoint
    )({ chain })

    const request = async ({ method, params }: { method: string; params?: unknown }) => {
      switch (method) {
        case 'eth_chainId':
          return numberToHex(chain.id)
        case 'net_version':
          return String(chain.id)
        case 'eth_accounts':
          return [walletAddress(tronWeb)].filter(Boolean)
        case 'eth_sendTransaction':
          return sendTransaction(tronWeb, feeLimit, params)
        case 'eth_signTypedData_v4':
        case 'eth_signTypedData':
          return signTypedData(tronWeb, params)
      }
      if (!FORWARDED_METHODS.has(method))
        throw new MethodNotSupportedRpcError(new Error(`${method} is not supported on Tron.`), {
          method,
        })
      const isCall = method === 'eth_call' || method === 'eth_estimateGas'
      const result: unknown = await read.request({
        method,
        params: isCall ? normalizeCallParams(tronWeb, params) : params,
      })
      return normalizeReadResult(method, result)
    }

    const transport = createTransport(
      { key, name, type: 'tronWeb', retryCount: 0, request: request as EIP1193RequestFn },
      { tronWeb },
    )
    // A wallet action must never be re-issued, even when the caller asks for retries.
    const once: EIP1193RequestFn = (args, options) =>
      transport.request(args, { ...options, retryCount: 0 })
    return { ...transport, request: once }
  }
}
