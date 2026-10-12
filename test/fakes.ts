import {
  type EIP1193RequestFn,
  type Hex,
  RpcRequestError,
  type Transport,
  concat,
  createTransport,
  keccak256,
  sha256,
  stringToHex,
} from 'viem'
import { sign } from 'viem/accounts'
import { vi } from 'vitest'
import type { TronWebLike } from '../src/types.js'

/** viem's well-known public test key (default local-node account #0). Not a secret. */
export const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
export const WALLET = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
export const WALLET_41 = '41f39fd6e51aad88f6f4ce6ab8827279cfffb92266'
export const WALLET_BASE58 = 'TYBNgWfhGuNzdLtjKtxXTfskAhTbMcqbaG'
export const CONTRACT = '0xa614f803b6fd780986a42c78ec9c7f77e6ded13c'
export const CONTRACT_41 = '41a614f803b6fd780986a42c78ec9c7f77e6ded13c'
export const CONTRACT_BASE58 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
export const OTHER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'

export const TRON_MESSAGE_HEADER = '\x19TRON Signed Message:\n32'

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const checksum = (hex: string) => sha256(sha256(`0x${hex}`)).slice(2, 10)

/** Same results and the same throws as TronWeb's `address.toHex`. */
export function toHex(address: string): string {
  if (/^(0x)?[0-9a-f]*$/i.test(address)) return address.toLowerCase().replace(/^0x/, '41')
  let value = 0n
  for (const character of address) {
    const index = ALPHABET.indexOf(character)
    if (index < 0) throw new Error('Non-base58 character')
    value = value * 58n + BigInt(index)
  }
  const hex = value.toString(16).padStart(50, '0')
  if (hex.length !== 50 || checksum(hex.slice(0, 42)) !== hex.slice(42))
    throw new Error('Invalid address provided')
  return hex.slice(0, 42)
}

/** Same results as TronWeb's `address.fromHex`. */
export function fromHex(address: string): string {
  if (!/^(0x)?[0-9a-f]+$/i.test(address)) return address
  const hex = address.toLowerCase().replace(/^0x/, '41')
  let value = BigInt(`0x${hex}${checksum(hex)}`)
  let base58 = ''
  for (; value > 0n; value /= 58n) base58 = (ALPHABET[Number(value % 58n)] ?? '') + base58
  return base58
}

function transaction(
  type: string,
  value: Record<string, unknown>,
  permissionId?: number,
  extra: object = {},
) {
  const parameter = { value, type_url: `type.googleapis.com/protocol.${type}` }
  const contract = { parameter, type, ...(permissionId ? { Permission_id: permissionId } : {}) }
  const raw_data = { contract: [contract], ...extra }
  const raw_data_hex = stringToHex(JSON.stringify(raw_data)).slice(2)
  return { visible: false, txID: sha256(`0x${raw_data_hex}`).slice(2), raw_data, raw_data_hex }
}

interface TriggerOptions {
  feeLimit?: number | undefined
  input?: string | undefined
  callValue?: number | undefined
  permissionId?: number | undefined
}

function triggerValue(contract: string, options: TriggerOptions, issuer: string) {
  return {
    data: options.input,
    owner_address: toHex(issuer),
    contract_address: toHex(contract),
    ...(options.callValue ? { call_value: options.callValue } : {}),
  }
}

const txIdOf = (tx: object) => ('txID' in tx && typeof tx.txID === 'string' ? tx.txID : '')

/** r ‖ s ‖ v with v as 27/28, the way TronWeb serialises a signature. */
async function signature(hash: Hex): Promise<string> {
  const { r, s, yParity } = await sign({ hash, privateKey: PRIVATE_KEY })
  return `${r.slice(2)}${s.slice(2)}${(27 + Number(yParity)).toString(16)}`
}

/**
 * A TronWeb stand-in backed by a real key. It returns what TronWeb 6 returns and throws where
 * TronWeb 6 throws; every method is a spy, so a test can count calls and replace one answer.
 */
export function fakeTronWeb() {
  const defaultAddress: TronWebLike['defaultAddress'] = { hex: WALLET_41, base58: WALLET_BASE58 }
  return {
    defaultAddress,
    address: { toHex: vi.fn(toHex), fromHex: vi.fn(fromHex) },
    trx: {
      sign: vi.fn(async (input: string | object): Promise<unknown> => {
        if (typeof input === 'string') {
          if (!/^(0x)?[0-9a-f]+$/i.test(input)) throw new Error('Expected hex message input')
          const message: Hex = `0x${input.replace(/^0x/, '')}`
          const hash = keccak256(concat([stringToHex(TRON_MESSAGE_HEADER), message]))
          return `0x${await signature(hash)}`
        }
        if (typeof input !== 'object') throw new Error('Invalid transaction provided')
        if ('signature' in input) throw new Error('Transaction is already signed')
        return { ...input, signature: [await signature(`0x${txIdOf(input)}`)] }
      }),
      sendRawTransaction: vi.fn((signed: object): Promise<unknown> => {
        if (typeof signed !== 'object') throw new Error('Invalid transaction provided')
        if (!('signature' in signed) || !Array.isArray(signed.signature))
          throw new Error('Transaction is not signed')
        return Promise.resolve({ result: true, txid: txIdOf(signed), transaction: signed })
      }),
    },
    transactionBuilder: {
      triggerSmartContract: vi.fn(
        (
          contract: string,
          _selector: string,
          options: TriggerOptions,
          _parameters: unknown[],
          issuer: string,
        ): Promise<unknown> => {
          if (!Number.isInteger(options.feeLimit) || Number(options.feeLimit) <= 0)
            throw new Error('Invalid feeLimit provided')
          const value = triggerValue(contract, options, issuer)
          return Promise.resolve({
            result: { result: true },
            transaction: transaction('TriggerSmartContract', value, options.permissionId, {
              fee_limit: options.feeLimit,
            }),
          })
        },
      ),
      triggerConstantContract: vi.fn(
        (
          contract: string,
          _selector: string,
          options: TriggerOptions,
          _parameters: unknown[],
          issuer: string,
        ): Promise<unknown> =>
          Promise.resolve({
            result: { result: true },
            energy_used: 13_000,
            constant_result: [''],
            transaction: {
              ret: [{}],
              ...transaction('TriggerSmartContract', triggerValue(contract, options, issuer)),
            },
          }),
      ),
      sendTrx: vi.fn(
        (
          to: string,
          amount: number,
          from: string,
          options: { permissionId?: number | undefined },
        ): Promise<unknown> => {
          if (toHex(to) === toHex(from)) throw new Error('Cannot transfer TRX to the same account')
          if (!Number.isInteger(amount) || amount <= 0) throw new Error('Invalid amount provided')
          const value = { to_address: toHex(to), owner_address: toHex(from), amount }
          return Promise.resolve(transaction('TransferContract', value, options.permissionId))
        },
      ),
    },
  } satisfies TronWebLike
}

export type FakeTronWeb = ReturnType<typeof fakeTronWeb>

type RpcBody = { result: unknown } | { error: { code: number; message: string; data?: unknown } }

/**
 * A read transport that never touches the network. `respond` plays the node; a JSON-RPC error
 * body is thrown the way viem's `http` transport throws it.
 */
export function stubRead(respond: (method: string, params: unknown) => RpcBody, retryCount = 0) {
  const request = vi.fn(({ method, params }: { method: string; params?: unknown }) => {
    const answer = respond(method, params)
    if ('error' in answer)
      throw new RpcRequestError({
        body: { method, params },
        error: answer.error,
        url: 'http://read.invalid',
      })
    return Promise.resolve(answer.result)
  })
  const transport: Transport = () =>
    createTransport({
      key: 'stub',
      name: 'Stub',
      type: 'stub',
      request: request as EIP1193RequestFn,
      retryCount,
      retryDelay: 0,
    })
  return { transport, request }
}

/** The three kinds of value a wallet throws, carrying the same text. */
export const thrownForms = (text: string) =>
  [
    ['a string', text],
    ['an object', { message: text }],
    ['an Error', new Error(text)],
  ] as const

/** A rejection with any value, as wallets produce them. */
export const rejection = (value: unknown) => () =>
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- wallets reject with non-errors
  Promise.reject(value)

/** The error a promise rejects with; fails when it resolves. */
export const failure = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    (value) => {
      throw new Error(`expected a rejection, got ${JSON.stringify(value)}`)
    },
    (error: unknown) => error,
  )

/** How many times each TronWeb entry point was called: build, simulate, transfer, sign, broadcast. */
export const callCounts = (tronWeb: FakeTronWeb) => ({
  build: tronWeb.transactionBuilder.triggerSmartContract.mock.calls.length,
  simulate: tronWeb.transactionBuilder.triggerConstantContract.mock.calls.length,
  transfer: tronWeb.transactionBuilder.sendTrx.mock.calls.length,
  sign: tronWeb.trx.sign.mock.calls.length,
  broadcast: tronWeb.trx.sendRawTransaction.mock.calls.length,
})

/** Call counts of a TronWeb nothing reached. */
export const NONE = { build: 0, simulate: 0, transfer: 0, sign: 0, broadcast: 0 }

/** Hex of a text without 0x, the way a node encodes its messages. */
export const hex = (text: string) => stringToHex(text).slice(2)
