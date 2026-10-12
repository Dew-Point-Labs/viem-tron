import { InvalidParamsRpcError } from 'viem'
import { TronWeb } from 'tronweb'
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
  thrownForms,
  toHex,
} from './fakes.js'

const thrown = thrownForms('Invalid address provided')

/** The value a call returns, or the message of what it throws. */
const outcome = (call: () => string) => {
  try {
    return call()
  } catch (error) {
    return `throws ${(error as Error).message}`
  }
}

describe('fake address conversion', () => {
  const inputs = [
    CONTRACT,
    CONTRACT.toUpperCase().replace('0X', '0x'),
    CONTRACT_41,
    CONTRACT_BASE58,
    WALLET_41,
    WALLET_BASE58,
    '0x1234',
    '',
    'zz',
    'hello world',
    'TR7NHqjeKQ',
    'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u',
  ]

  it.each(inputs)('toHex(%j) behaves as the installed TronWeb', (input) => {
    expect(outcome(() => toHex(input))).toBe(outcome(() => TronWeb.address.toHex(input)))
  })

  it.each(inputs)('fromHex(%j) behaves as the installed TronWeb', (input) => {
    expect(outcome(() => fromHex(input))).toBe(outcome(() => TronWeb.address.fromHex(input)))
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

  it.each([[undefined], [null]])('is undefined when defaultAddress is %o', (value) => {
    const tronWeb = fakeTronWeb()
    Object.assign(tronWeb, { defaultAddress: value })
    expect(walletAddress(tronWeb)).toBeUndefined()
  })

  it('is undefined when the wallet has no account or reports a malformed one', () => {
    const tronWeb = fakeTronWeb()
    tronWeb.defaultAddress = { hex: false, base58: false }
    expect(walletAddress(tronWeb)).toBeUndefined()
    tronWeb.defaultAddress = { hex: '41zz', base58: WALLET_BASE58 }
    expect(walletAddress(tronWeb)).toBeUndefined()
  })
})
