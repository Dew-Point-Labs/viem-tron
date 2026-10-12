import type { Address } from 'viem'
import { invalidParams } from './errors.js'
import type { TronWebLike } from './types.js'

const HEX_ADDRESS = /^(?:0x|41)([0-9a-f]{40})$/i

/** The 0x form of an address given as 0x, 41-hex or base58; `undefined` when it is not one. */
export function to0x(tronWeb: TronWebLike, value: unknown): Address | undefined {
  if (typeof value !== 'string') return undefined
  try {
    // Only base58 needs TronWeb, which also verifies its checksum; its result is not trusted
    // blindly because `toHex` returns malformed hex unchanged.
    const hex = HEX_ADDRESS.test(value) ? value : tronWeb.address.toHex(value)
    const body = HEX_ADDRESS.exec(hex)?.[1]
    return body === undefined ? undefined : `0x${body.toLowerCase()}`
  } catch {
    return undefined
  }
}

/** The base58 form TronWeb's builders expect. */
export function toBase58(tronWeb: TronWebLike, address: Address): string {
  try {
    return tronWeb.address.fromHex(`41${address.slice(2)}`)
  } catch (thrown) {
    throw invalidParams(`Address ${address} could not be converted to base58.`, thrown)
  }
}

/** The wallet's account in 0x form, or `undefined` when the wallet has none. */
export function walletAddress(tronWeb: TronWebLike): Address | undefined {
  return to0x(tronWeb, tronWeb.defaultAddress.hex || tronWeb.defaultAddress.base58)
}
