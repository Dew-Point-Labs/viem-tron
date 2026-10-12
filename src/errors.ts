import {
  BaseError,
  type Hex,
  InvalidParamsRpcError,
  UserRejectedRequestError,
  hexToString,
} from 'viem'
import { HEX_BYTES, isRecord } from './types.js'

/**
 * Text of a thrown value or of a node answer. Nodes return some messages hex-encoded: a string
 * of at least four hex bytes that decodes to printable ASCII is decoded, anything else is kept
 * as is (a short word such as `dead` is more likely text than an encoded message).
 */
export function messageOf(source: unknown): string {
  const text = isRecord(source) ? source.message : source
  if (typeof text !== 'string') return ''
  if (text.length < 8 || !HEX_BYTES.test(text)) return text
  const decoded = hexToString(`0x${text}`)
  return /^[\x20-\x7e]+$/.test(decoded) ? decoded : text
}

/**
 * Base class of every Tron-specific failure. viem surfaces these wrapped in its
 * `TransactionRejectedRpcError`; find them with `error.walk((e) => e instanceof TronWebTransportError)`.
 */
export class TronWebTransportError extends BaseError {
  // The one code viem neither retries nor passes to the next transport of a `fallback()`.
  readonly code = -32003

  constructor(shortMessage: string, cause?: unknown) {
    super(shortMessage)
    // viem's wrapper shows only the `details` of its cause: keep the whole message visible there.
    this.details = shortMessage
    // Wallets throw strings and plain objects; viem's own `cause` option only takes an Error.
    this.cause = cause
  }
}

/** The pre-sign simulation reverted or ran out of energy. Nothing was signed. */
export class TransactionRevertedError extends TronWebTransportError {
  override name = 'TransactionRevertedError'
  /** `'OUT_OF_ENERGY'` when the call ran out of energy. */
  reason?: 'OUT_OF_ENERGY' | undefined
  /** Revert bytes, when the node returned them. */
  data?: Hex | undefined

  constructor(shortMessage: string, cause?: unknown, reason?: 'OUT_OF_ENERGY', data?: Hex) {
    super(shortMessage, cause)
    this.reason = reason
    this.data = data
  }
}

/** The pre-sign simulation could not be performed. Nothing was signed. */
export class SimulationUnavailableError extends TronWebTransportError {
  override name = 'SimulationUnavailableError'
}

/** The node refused to build the transaction. Nothing was signed. */
export class TransactionBuildError extends TronWebTransportError {
  override name = 'TransactionBuildError'
}

/** The signer failed or returned an unusable result. Nothing was broadcast. */
export class SigningError extends TronWebTransportError {
  override name = 'SigningError'
}

/** The node refused the signed transaction. */
export class BroadcastError extends TronWebTransportError {
  override name = 'BroadcastError'
  /** The node's error code, for example `SIGERROR`. */
  nodeCode?: string | undefined

  constructor(shortMessage: string, cause?: unknown, nodeCode?: string) {
    super(shortMessage, cause)
    this.nodeCode = nodeCode
  }
}

/**
 * The broadcast outcome is unknown: the transaction may have been accepted. Look
 * `transactionId` up before sending again.
 */
export class BroadcastIndeterminateError extends TronWebTransportError {
  override name = 'BroadcastIndeterminateError'
  /** Id of the signed transaction, `0x`-prefixed. */
  transactionId: Hex
  /** The same id, in the only extra field a wrapping EIP-1193 provider forwards. */
  data: { transactionId: Hex }

  constructor(transactionId: Hex, cause?: unknown) {
    super(
      `The broadcast outcome of transaction ${transactionId} is unknown. It may have been accepted: look the id up before sending again.`,
      cause,
    )
    this.transactionId = transactionId
    this.data = { transactionId }
  }
}

export function invalidParams(reason: string, cause?: unknown): InvalidParamsRpcError {
  return new InvalidParamsRpcError(new Error(reason, { cause }))
}

const USER_REJECTION =
  /declined by user|user (reject|denied|cancel)|(cancell?ed|rejected|denied) by (the )?user/i

/** Maps a value thrown by the signer to a user rejection (4001) or a {@link SigningError}. */
export function signingFailure(thrown: unknown): UserRejectedRequestError | SigningError {
  const text = messageOf(thrown)
  const code: unknown = isRecord(thrown) ? thrown.code : undefined
  const rejected = code === 4001 || code === '4001' || USER_REJECTION.test(text)
  if (!rejected) return new SigningError(`Signing failed: ${text || 'unknown error'}`, thrown)
  return new UserRejectedRequestError(
    thrown instanceof Error ? thrown : new Error(text, { cause: thrown }),
  )
}

/** Every call into TronWeb goes through here, so that nothing it throws leaves unconverted. */
export async function guard<T>(
  call: () => T | Promise<T>,
  wrap: (thrown: unknown) => Error,
): Promise<T> {
  try {
    return await call()
  } catch (thrown) {
    throw wrap(thrown)
  }
}
