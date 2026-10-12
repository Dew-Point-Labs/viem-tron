import { InvalidParamsRpcError } from 'viem'
import { describe, expect, it } from 'vitest'
import { to0x, toBase58, walletAddress } from '../src/address.js'
import {
  CONTRACT,
  CONTRACT_41,
  CONTRACT_BASE58,
  WALLET,
  WALLET_41,
  WALLET_BASE58,
  fakeTronWeb,
  fromHex,
  toHex,
} from './fakes.js'

const thrown = [
  ['a string', 'Invalid address provided'],
  ['an object', { message: 'Invalid address provided' }],
  ['an Error', new Error('Invalid address provided')],
] as const

describe('fake address conversion', () => {
  it('matches values produced by TronWeb 6', () => {
    expect(toHex(CONTRACT_BASE58)).toBe(CONTRACT_41)
    expect(toHex(CONTRACT)).toBe(CONTRACT_41)
    expect(toHex('0x1234')).toBe('411234')
    expect(toHex('')).toBe('')
    expect(fromHex(CONTRACT_41)).toBe(CONTRACT_BASE58)
    expect(fromHex(CONTRACT)).toBe(CONTRACT_BASE58)
    expect(fromHex(WALLET_41)).toBe(WALLET_BASE58)
    expect(fromHex('zz')).toBe('zz')
    expect(() => toHex('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u')).toThrow('Invalid address provided')
    expect(() => toHex('TR7NHqjeKQ')).toThrow('Invalid address provided')
    expect(() => toHex('hello world')).toThrow('Non-base58 character')
  })
})

describe('to0x', () => {
  it('accepts 0x, 41-hex and base58 and returns lowercase 0x', () => {
    const tronWeb = fakeTronWeb()
    expect(to0x(tronWeb, CONTRACT)).toBe(CONTRACT)
    expect(to0x(tronWeb, CONTRACT.toUpperCase().replace('0X', '0x'))).toBe(CONTRACT)
    expect(to0x(tronWeb, CONTRACT_41)).toBe(CONTRACT)
    expect(to0x(tronWeb, CONTRACT_41.toUpperCase())).toBe(CONTRACT)
    expect(to0x(tronWeb, CONTRACT_BASE58)).toBe(CONTRACT)
    expect(to0x(tronWeb, `0x41${'0'.repeat(38)}`)).toBe(`0x41${'0'.repeat(38)}`)
  })

  it.each([
    ['base58 with a bad checksum', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u'],
    ['truncated base58', 'TR7NHqjeKQ'],
    ['text', 'hello world'],
    ['an empty string', ''],
    ['short hex', '0x1234'],
    ['0x with 21 bytes', `${CONTRACT}00`],
    ['41-hex with 19 bytes', CONTRACT_41.slice(0, 40)],
    ['bare 20-byte hex', CONTRACT.slice(2)],
    ['a number', 5],
    ['null', null],
    ['undefined', undefined],
    ['false', false],
    ['an object', {}],
  ])('rejects %s', (_, value) => {
    expect(to0x(fakeTronWeb(), value)).toBeUndefined()
  })

  it.each(thrown)('treats %s thrown by TronWeb as "not an address"', (_, value) => {
    const tronWeb = fakeTronWeb()
    tronWeb.address.toHex.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- wallets throw non-errors
      throw value
    })
    expect(to0x(tronWeb, CONTRACT_BASE58)).toBeUndefined()
  })

  it('does not trust a conversion result that is not 41-hex', () => {
    const tronWeb = fakeTronWeb()
    tronWeb.address.toHex.mockReturnValue(CONTRACT_BASE58)
    expect(to0x(tronWeb, CONTRACT_BASE58)).toBeUndefined()
  })
})

describe('toBase58', () => {
  it('converts through the instance, passing 41-hex', () => {
    const tronWeb = fakeTronWeb()
    expect(toBase58(tronWeb, CONTRACT)).toBe(CONTRACT_BASE58)
    expect(tronWeb.address.fromHex).toHaveBeenCalledExactlyOnceWith(CONTRACT_41)
  })

  it.each(thrown)('converts %s thrown by TronWeb to InvalidParamsRpcError', (_, value) => {
    const tronWeb = fakeTronWeb()
    tronWeb.address.fromHex.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- wallets throw non-errors
      throw value
    })
    const error = (() => {
      try {
        return toBase58(tronWeb, CONTRACT)
      } catch (e) {
        return e
      }
    })()
    expect(error).toBeInstanceOf(InvalidParamsRpcError)
    expect(((error as Error).cause as Error).cause).toBe(value)
  })
})

describe('walletAddress', () => {
  it('is the 0x form of the default address', () => {
    expect(walletAddress(fakeTronWeb())).toBe(WALLET)
  })

  it('falls back to the base58 form', () => {
    const tronWeb = fakeTronWeb()
    tronWeb.defaultAddress.hex = false
    expect(walletAddress(tronWeb)).toBe(WALLET)
  })

  it('is undefined when the wallet has no account or reports a malformed one', () => {
    const tronWeb = fakeTronWeb()
    tronWeb.defaultAddress = { hex: false, base58: false }
    expect(walletAddress(tronWeb)).toBeUndefined()
    tronWeb.defaultAddress = { hex: '41zz', base58: WALLET_BASE58 }
    expect(walletAddress(tronWeb)).toBeUndefined()
  })
})
