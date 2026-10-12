import { InvalidParamsRpcError } from 'viem'
import { describe, expect, it } from 'vitest'
import { normalizeCallParams, normalizeReadResult } from '../src/reads.js'
import {
  CONTRACT,
  CONTRACT_41,
  CONTRACT_BASE58,
  OTHER,
  WALLET,
  WALLET_BASE58,
  fakeTronWeb,
} from './fakes.js'

describe('normalizeCallParams', () => {
  it('converts base58 and 41-hex `to` / `from` to 0x and keeps the other fields and params', () => {
    const params = [
      { to: CONTRACT_BASE58, from: WALLET_BASE58, data: '0xAbCd', value: '0x1' },
      'latest',
    ]
    expect(normalizeCallParams(fakeTronWeb(), params)).toEqual([
      { to: CONTRACT, from: WALLET, data: '0xAbCd', value: '0x1' },
      'latest',
    ])
    expect(normalizeCallParams(fakeTronWeb(), [{ to: CONTRACT_41, from: OTHER }])).toEqual([
      { to: CONTRACT, from: OTHER },
    ])
  })

  it("does not mutate the caller's params", () => {
    const call = { to: CONTRACT_BASE58 }
    normalizeCallParams(fakeTronWeb(), [call])
    expect(call).toEqual({ to: CONTRACT_BASE58 })
  })

  it('fills a missing `from` with the wallet address', () => {
    expect(normalizeCallParams(fakeTronWeb(), [{ to: CONTRACT, data: '0x' }])).toEqual([
      { to: CONTRACT, data: '0x', from: WALLET },
    ])
    expect(normalizeCallParams(fakeTronWeb(), [{ to: CONTRACT, from: null }])).toEqual([
      { to: CONTRACT, from: WALLET },
    ])
  })

  it('leaves `from` absent when the wallet has no address, and never uses the zero address', () => {
    const tronWeb = fakeTronWeb()
    tronWeb.defaultAddress = { hex: false, base58: false }
    const [call] = normalizeCallParams(tronWeb, [{ to: CONTRACT }]) as [Record<string, unknown>]
    expect(call).toEqual({ to: CONTRACT })
    expect('from' in call).toBe(false)
  })

  it('leaves a missing `to` absent', () => {
    expect(normalizeCallParams(fakeTronWeb(), [{ data: '0x00' }])).toEqual([
      { data: '0x00', from: WALLET },
    ])
  })

  it.each([
    ['to', { to: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u' }],
    ['to', { to: '0x1234' }],
    ['to', { to: 5 }],
    ['from', { to: CONTRACT, from: 'nobody' }],
    ['from', { to: CONTRACT, from: {} }],
  ])('rejects a present but malformed `%s`', (key, call) => {
    const error = (() => {
      try {
        return normalizeCallParams(fakeTronWeb(), [call])
      } catch (e) {
        return e
      }
    })()
    expect(error).toBeInstanceOf(InvalidParamsRpcError)
    expect((error as InvalidParamsRpcError).details).toContain(`\`${key}\``)
  })

  it.each([[undefined], [[]], [['0xabc']], [[null]], ['text'], [[[1]]]])(
    'passes params without a call object through untouched: %j',
    (params) => {
      expect(normalizeCallParams(fakeTronWeb(), params)).toBe(params)
    },
  )
})

describe('normalizeReadResult', () => {
  it('eth_getTransactionByHash: "0x" placeholders of a pending transaction become null / 0x0', () => {
    const pending = {
      hash: '0xaa',
      blockHash: '0x',
      blockNumber: '0x',
      transactionIndex: '0x',
      gasPrice: '0x',
      input: '0x',
      value: '0x0',
    }
    expect(normalizeReadResult('eth_getTransactionByHash', pending)).toEqual({
      hash: '0xaa',
      blockHash: null,
      blockNumber: null,
      transactionIndex: null,
      gasPrice: '0x0',
      input: '0x',
      value: '0x0',
    })
    expect(pending.blockHash).toBe('0x')
  })

  it('eth_getTransactionByHash: an included transaction and a null result are unchanged', () => {
    const included = {
      blockHash: '0xbb',
      blockNumber: '0x1',
      transactionIndex: '0x0',
      gasPrice: '0x1a4',
    }
    expect(normalizeReadResult('eth_getTransactionByHash', included)).toEqual(included)
    expect(normalizeReadResult('eth_getTransactionByHash', null)).toBeNull()
  })

  it('eth_getTransactionReceipt: a final receipt is returned as is', () => {
    const receipt = { blockHash: '0xbb', blockNumber: '0x1', status: '0x1', logs: [] }
    expect(normalizeReadResult('eth_getTransactionReceipt', receipt)).toBe(receipt)
    expect(normalizeReadResult('eth_getTransactionReceipt', null)).toBeNull()
  })

  describe.each(['blockHash', 'blockNumber', 'status'])(
    'eth_getTransactionReceipt: a receipt whose %s',
    (key) => {
      const receipt = { blockHash: '0xbb', blockNumber: '0x1', status: '0x0' }

      it.each([[undefined], [null], ['0x']])('is %o is null', (value) => {
        expect(
          normalizeReadResult('eth_getTransactionReceipt', { ...receipt, [key]: value }),
        ).toBeNull()
      })

      it('is missing is null', () => {
        const rest = Object.fromEntries(Object.entries(receipt).filter(([name]) => name !== key))
        expect(normalizeReadResult('eth_getTransactionReceipt', rest)).toBeNull()
      })
    },
  )

  it('other methods are untouched', () => {
    const block = { hash: '0x', number: '0x' }
    expect(normalizeReadResult('eth_getBlockByNumber', block)).toBe(block)
    expect(normalizeReadResult('eth_call', '0x')).toBe('0x')
  })
})
