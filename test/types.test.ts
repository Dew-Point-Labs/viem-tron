import { describe, expect, it } from 'vitest'
import { isRecord, toSafeInteger } from '../src/types.js'

describe('isRecord', () => {
  it('accepts plain objects only', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord(new Error('x'))).toBe(true)
    for (const value of [null, undefined, [], 'a', 1, 1n, true]) expect(isRecord(value)).toBe(false)
  })
})

describe('toSafeInteger', () => {
  it('accepts numbers, bigints and 0x quantities', () => {
    expect(toSafeInteger(0)).toBe(0)
    expect(toSafeInteger(7)).toBe(7)
    expect(toSafeInteger(7n)).toBe(7)
    expect(toSafeInteger('0x10')).toBe(16)
    expect(toSafeInteger('0X0a')).toBe(10)
    expect(toSafeInteger(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
    expect(toSafeInteger(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER)
    expect(toSafeInteger('0x1fffffffffffff')).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('rejects everything else', () => {
    const rejected = [-1, -1n, 1.5, NaN, Infinity, 2 ** 53, 2n ** 53n, '0x20000000000000']
    const notQuantities = [
      '0x',
      '0xzz',
      '10',
      '',
      ' 0x1',
      '-0x1',
      '1e3',
      null,
      undefined,
      {},
      [],
      true,
    ]
    for (const value of [...rejected, ...notQuantities])
      expect(toSafeInteger(value)).toBeUndefined()
  })

  it('accepts decimal strings only on request', () => {
    expect(toSafeInteger('728126428', true)).toBe(728126428)
    expect(toSafeInteger('0x2b6653dc', true)).toBe(728126428)
    for (const value of ['9007199254740992', '1.5', '-1', '1e3', '', '12a'])
      expect(toSafeInteger(value, true)).toBeUndefined()
  })
})
