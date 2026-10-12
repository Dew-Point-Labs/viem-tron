import type { Transport } from 'viem'

/**
 * Options of a contract call. Amounts are in SUN. The keys are exact (no `| undefined`) so that
 * TronWeb's own option types stay assignable under `exactOptionalPropertyTypes`.
 */
interface TriggerOptions {
  feeLimit?: number
  input?: string
  callValue?: number
  permissionId?: number
}

/**
 * The part of a TronWeb instance the transport calls. A `TronWeb` object created by the
 * application and the one injected by a wallet both satisfy it.
 *
 * Only wallet actions go through it; reads go to the JSON-RPC endpoint.
 */
export interface TronWebLike {
  /** The wallet's account; both forms are `false` while no account is available. */
  defaultAddress: { hex: string | false; base58: string | false }
  address: {
    /** Any address form to 41-prefixed hex. */
    toHex(address: string): string
    /** 41-prefixed hex to base58. */
    fromHex(address: string): string
  }
  trx: {
    /** Signs a transaction object, or a hex string as a Tron signed message. */
    sign(transaction: string | object): Promise<unknown>
    /** Broadcasts a signed transaction and returns the node's answer. */
    sendRawTransaction(signedTransaction: object): Promise<unknown>
  }
  transactionBuilder: {
    /**
     * Builds a contract call; `options.feeLimit` and `options.callValue` are in SUN. The
     * transport passes the calldata as `options.input` and always an empty `parameters` list.
     */
    triggerSmartContract(
      contractAddress: string,
      functionSelector: string,
      options: TriggerOptions,
      parameters: never[],
      issuerAddress: string,
    ): Promise<unknown>
    /** Simulates a contract call without broadcasting it. */
    triggerConstantContract(
      contractAddress: string,
      functionSelector: string,
      options: TriggerOptions,
      parameters: never[],
      issuerAddress: string,
    ): Promise<unknown>
    /** Builds a TRX transfer; `amount` is in SUN. */
    sendTrx(
      to: string,
      amount: number,
      from: string,
      options: { permissionId?: number },
    ): Promise<unknown>
  }
}

/** Options of {@link tronWebTransport}. */
export interface TronWebTransportConfig {
  /**
   * Where reads go: a Tron JSON-RPC URL, or a viem transport used as given.
   * Defaults to the chain's first default HTTP RPC URL.
   */
  rpc?: string | Transport | undefined
  /** Upper bound a contract call may burn, in SUN. Default `300_000_000` (300 TRX). */
  feeLimit?: number | undefined
  /** Transport key. Default `'tronWeb'`. */
  key?: string | undefined
  /** Transport name. Default `'TronWeb'`. */
  name?: string | undefined
  /** Retries of a failed read, when `rpc` is a URL. Wallet actions are never retried. */
  retryCount?: number | undefined
  /** Base delay between read retries in milliseconds, when `rpc` is a URL. */
  retryDelay?: number | undefined
  /** Timeout of a read in milliseconds, when `rpc` is a URL. Wallet actions have no timeout. */
  timeout?: number | undefined
}

/** The transport returned by {@link tronWebTransport}; `value.tronWeb` is the wrapped instance. */
export type TronWebTransport = Transport<'tronWeb', { tronWeb: TronWebLike }>

/** One or more whole bytes of hex, without `0x`. */
export const HEX_BYTES = /^(?:[0-9a-f]{2})+$/i

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A number, bigint or `0x` quantity (optionally a decimal string) as a non-negative safe integer. */
export function toSafeInteger(value: unknown, allowDecimal = false): number | undefined {
  const quantity = allowDecimal ? /^(0x[0-9a-fA-F]+|\d+)$/ : /^0x[0-9a-fA-F]+$/
  const parsed = typeof value === 'string' && quantity.test(value) ? BigInt(value) : value
  const number = typeof parsed === 'bigint' ? Number(parsed) : parsed
  return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0
    ? number
    : undefined
}
