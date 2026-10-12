import type { TronWeb } from 'tronweb'
import type { BaseError, EIP1193RequestFn, Hex, Transport } from 'viem'
import { describe, expectTypeOf, it } from 'vitest'
import {
  BroadcastError,
  BroadcastIndeterminateError,
  SigningError,
  TransactionRevertedError,
  type TronWebLike,
  type TronWebTransport,
  type TronWebTransportConfig,
  tronWebTransport,
} from '../src/index.js'

describe('TronWebLike', () => {
  it('is satisfied by the real TronWeb class', () => {
    expectTypeOf<TronWeb>().toExtend<TronWebLike>()
  })

  it('is satisfied by an object whose methods take narrower parameters', () => {
    interface Injected {
      defaultAddress: { hex: string | false; base58: string | false }
      address: { toHex(address: string): string; fromHex(address: string): string }
      trx: {
        sign(transaction: string | { txID: string }): Promise<string | { signature: string[] }>
        sendRawTransaction(signed: {
          txID: string
          signature: string[]
        }): Promise<{ result: boolean }>
      }
      transactionBuilder: {
        triggerSmartContract(
          contract: string,
          selector: string,
          options: { feeLimit?: number; input?: string; callValue?: number },
          parameters: { type: string; value: unknown }[],
          issuer: string,
        ): Promise<{ transaction: { txID: string } }>
        triggerConstantContract(
          contract: string,
          selector: string,
          options: { input?: string },
          parameters: { type: string; value: unknown }[],
          issuer: string,
        ): Promise<{ constant_result: string[] }>
        sendTrx(to: string, amount: number, from: string): Promise<{ txID: string }>
      }
    }
    expectTypeOf<Injected>().toExtend<TronWebLike>()
  })

  it('rejects an object without the signer', () => {
    expectTypeOf<Omit<TronWebLike, 'trx'>>().not.toExtend<TronWebLike>()
  })
})

describe('tronWebTransport', () => {
  it('takes a TronWebLike and an optional config and returns a TronWebTransport', () => {
    expectTypeOf(tronWebTransport).parameter(0).toEqualTypeOf<TronWebLike>()
    expectTypeOf(tronWebTransport).parameter(1).toEqualTypeOf<TronWebTransportConfig | undefined>()
    expectTypeOf(tronWebTransport).returns.toEqualTypeOf<TronWebTransport>()
  })

  it('TronWebTransport is a viem Transport carrying the TronWeb instance', () => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-arguments -- spelled out as documented
    type Documented = Transport<'tronWeb', { tronWeb: TronWebLike }, EIP1193RequestFn>
    expectTypeOf<TronWebTransport>().toEqualTypeOf<Documented>()
    expectTypeOf<TronWebTransport>().toExtend<Transport>()
  })

  it('every config key is optional and accepts an explicit undefined', () => {
    expectTypeOf<Record<string, never>>().toExtend<TronWebTransportConfig>()
    expectTypeOf<{ rpc: undefined; feeLimit: undefined }>().toExtend<TronWebTransportConfig>()
    expectTypeOf<keyof TronWebTransportConfig>().toEqualTypeOf<'rpc' | 'feeLimit'>()
    expectTypeOf<TronWebTransportConfig['rpc']>().toEqualTypeOf<string | Transport | undefined>()
    expectTypeOf<TronWebTransportConfig['feeLimit']>().toEqualTypeOf<number | undefined>()
  })
})

describe('errors', () => {
  it('extend viem BaseError and expose their fields', () => {
    expectTypeOf<SigningError>().toExtend<BaseError>()
    expectTypeOf<TransactionRevertedError['reason']>().toEqualTypeOf<'OUT_OF_ENERGY' | undefined>()
    expectTypeOf<TransactionRevertedError['data']>().toEqualTypeOf<Hex | undefined>()
    expectTypeOf<BroadcastError['nodeCode']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<BroadcastIndeterminateError['transactionId']>().toEqualTypeOf<Hex>()
    expectTypeOf<BroadcastIndeterminateError['data']>().toEqualTypeOf<{ transactionId: Hex }>()
  })
})
