import {
  InvalidParamsRpcError,
  UserRejectedRequestError,
  concat,
  hashTypedData,
  keccak256,
  recoverAddress,
  stringToHex,
} from 'viem'
import { describe, expect, it } from 'vitest'
import { SigningError } from '../src/errors.js'
import { signTypedData } from '../src/signTypedData.js'
import {
  CONTRACT,
  type FakeTronWeb,
  OTHER,
  TRON_MESSAGE_HEADER,
  WALLET,
  WALLET_41,
  WALLET_BASE58,
  callCounts,
  failure,
  fakeTronWeb,
  rejection,
  thrownForms,
} from './fakes.js'

const CHAIN_ID = 728126428
const types = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const
const domainTypes = [
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
] as const
const message = { to: OTHER, value: '1000000', data: '0xa9059cbb', nonce: 7 } as const
const typedData = (chainId: unknown = CHAIN_ID, withDomainType = false) => ({
  types: withDomainType ? { EIP712Domain: domainTypes, ...types } : types,
  domain: { chainId, verifyingContract: CONTRACT },
  primaryType: 'SafeTx',
  message,
})
/** What viem computes for the same input with a numeric chain id. */
const expectedDigest = hashTypedData({
  types,
  domain: { chainId: CHAIN_ID, verifyingContract: CONTRACT },
  primaryType: 'SafeTx',
  message: { ...message, value: 1_000_000n, nonce: 7n },
})
const signedInput = (tronWeb: FakeTronWeb) => tronWeb.trx.sign.mock.calls[0]?.[0]

async function expectInvalidParams(params: unknown, tronWeb = fakeTronWeb()) {
  const error = await failure(signTypedData(tronWeb, params))
  expect(error).toBeInstanceOf(InvalidParamsRpcError)
  expect(callCounts(tronWeb).sign).toBe(0)
  return error as InvalidParamsRpcError
}

describe('fake signer', () => {
  it('matches the signature TronWeb 6 produces for the same key and message', async () => {
    expect(await fakeTronWeb().trx.sign('aa'.repeat(32))).toBe(
      '0xefa22e99f3ca1cae08c763e83ecbaed688379c8d4163b00339d4b9ee36d31d7f584323d72e4e0f23fbba4201edc515c6cfef49a1d7aa25fb915cd675991922171b',
    )
  })
})

describe('1. address', () => {
  it.each([[WALLET], [WALLET.toUpperCase().replace('0X', '0x')], [WALLET_41], [WALLET_BASE58]])(
    'accepts the wallet address as %s',
    async (address) => {
      await expect(signTypedData(fakeTronWeb(), [address, typedData()])).resolves.toMatch(
        /^0x[0-9a-f]{130}$/,
      )
    },
  )

  it.each([[OTHER], ['0x1234'], ['nobody'], [undefined], [null], [5]])(
    'rejects an address that is not the wallet address: %o',
    async (address) => {
      await expectInvalidParams([address, typedData()])
    },
  )

  it('rejects when the wallet has no address', async () => {
    const tronWeb = fakeTronWeb()
    tronWeb.defaultAddress = { hex: false, base58: false }
    await expectInvalidParams([WALLET, typedData()], tronWeb)
  })

  it.each([[undefined], ['text'], [{}]])(
    'rejects params that are not an array: %o',
    async (params) => {
      await expectInvalidParams(params)
    },
  )
})

describe('2. parse', () => {
  it('accepts a JSON string', async () => {
    const tronWeb = fakeTronWeb()
    await signTypedData(tronWeb, [WALLET, JSON.stringify(typedData())])
    expect(signedInput(tronWeb)).toBe(expectedDigest.slice(2))
  })

  it('rejects a string that is not JSON, keeping the parse error', async () => {
    const error = await expectInvalidParams([WALLET, '{not json'])
    expect(((error.cause as Error).cause as Error).name).toBe('SyntaxError')
  })

  it.each([
    ['is missing', undefined],
    ['is null', null],
    ['is an array', []],
    ['is JSON for a non-object', '5'],
    ['has no types', { ...typedData(), types: undefined }],
    ['has array types', { ...typedData(), types: [] }],
    ['has no domain', { ...typedData(), domain: undefined }],
    ['has a string domain', { ...typedData(), domain: 'x' }],
    ['has no message', { ...typedData(), message: undefined }],
    ['has a null message', { ...typedData(), message: null }],
    ['has no primaryType', { ...typedData(), primaryType: undefined }],
    ['has a non-string primaryType', { ...typedData(), primaryType: 5 }],
  ])('rejects typed data that %s', async (_, data) => {
    await expectInvalidParams([WALLET, data])
  })
})

describe('3. domain and 4. digest', () => {
  it.each([
    ['a number', CHAIN_ID],
    ['a 0x hex string', '0x2b6653dc'],
    ['a decimal string', '728126428'],
    ['a bigint', 728126428n],
  ])('the digest equals viem hashTypedData when chainId is %s', async (_, chainId) => {
    for (const withDomainType of [false, true]) {
      const tronWeb = fakeTronWeb()
      await signTypedData(tronWeb, [WALLET, typedData(chainId, withDomainType)])
      // The signer receives the digest as hex without 0x.
      expect(signedInput(tronWeb)).toBe(expectedDigest.slice(2))
      expect(tronWeb.trx.sign).toHaveBeenCalledTimes(1)
    }
  })

  it('honours an EIP712Domain entry in `types`', async () => {
    const tronWeb = fakeTronWeb()
    const data = {
      ...typedData(),
      types: { EIP712Domain: [{ name: 'verifyingContract', type: 'address' }], ...types },
    }
    await signTypedData(tronWeb, [WALLET, data])
    // The declared domain type leaves chainId out, so the digest differs from the derived one.
    const declared = hashTypedData({
      types: { EIP712Domain: [{ name: 'verifyingContract', type: 'address' }], ...types },
      domain: { verifyingContract: CONTRACT },
      primaryType: 'SafeTx',
      message: { ...message, value: 1_000_000n, nonce: 7n },
    })
    expect(declared).not.toBe(expectedDigest)
    expect(signedInput(tronWeb)).toBe(declared.slice(2))
  })

  it('injects nothing into the domain', async () => {
    const tronWeb = fakeTronWeb()
    const data = { ...typedData(), domain: { verifyingContract: CONTRACT } }
    await signTypedData(tronWeb, [WALLET, data])
    const bare = hashTypedData({
      types,
      domain: { verifyingContract: CONTRACT },
      primaryType: 'SafeTx',
      message: { ...message, value: 1_000_000n, nonce: 7n },
    })
    expect(signedInput(tronWeb)).toBe(bare.slice(2))
  })

  it("does not mutate the caller's typed data", async () => {
    const data = typedData('0x2b6653dc')
    await signTypedData(fakeTronWeb(), [WALLET, data])
    expect(data.domain.chainId).toBe('0x2b6653dc')
  })

  it.each([
    [true],
    [{}],
    [[1]],
    [1.5],
    [-1],
    ['1.5'],
    ['abc'],
    [''],
    [2 ** 53],
    [2n ** 53n],
    ['9007199254740992'],
    [null],
  ])('rejects chainId %o', async (chainId) => {
    await expectInvalidParams([WALLET, typedData(chainId)])
  })

  it.each([
    ['an unknown primaryType', { ...typedData(), primaryType: 'Nope' }],
    [
      'an invalid address in the message',
      { ...typedData(), message: { ...message, to: '0x1234' } },
    ],
    ['malformed types', { ...typedData(), types: { SafeTx: 'x' } }],
  ])('rejects %s, keeping the hashing error', async (_, data) => {
    const error = await expectInvalidParams([WALLET, data])
    expect((error.cause as Error).cause).toBeInstanceOf(Error)
  })
})

describe('5. sign', () => {
  it.each(thrownForms('Confirmation declined by user'))(
    'a refusal thrown as %s is UserRejectedRequestError (4001)',
    async (_, thrown) => {
      const tronWeb = fakeTronWeb()
      tronWeb.trx.sign.mockImplementationOnce(rejection(thrown))
      const error = await failure(signTypedData(tronWeb, [WALLET, typedData()]))
      expect(error).toBeInstanceOf(UserRejectedRequestError)
      expect((error as UserRejectedRequestError).code).toBe(4001)
      expect(tronWeb.trx.sign).toHaveBeenCalledTimes(1)
    },
  )

  it.each(thrownForms('Expected hex message input'))(
    'any other failure thrown as %s is SigningError',
    async (_, thrown) => {
      const tronWeb = fakeTronWeb()
      tronWeb.trx.sign.mockImplementationOnce(rejection(thrown))
      const error = await failure(signTypedData(tronWeb, [WALLET, typedData()]))
      expect(error).toBeInstanceOf(SigningError)
      expect((error as SigningError).cause).toBe(thrown)
      expect(tronWeb.trx.sign).toHaveBeenCalledTimes(1)
    },
  )
})

describe('6. normalise', () => {
  const rs = 'ab'.repeat(64)
  const signWith = async (result: unknown) => {
    const tronWeb = fakeTronWeb()
    tronWeb.trx.sign.mockResolvedValueOnce(result)
    return signTypedData(tronWeb, [WALLET, typedData()])
  }

  it.each([
    ['00', '1b'],
    ['01', '1c'],
    ['1b', '1b'],
    ['1c', '1c'],
    ['1B', '1b'],
  ])('v %s becomes %s', async (v, expected) => {
    expect(await signWith(`0x${rs}${v}`)).toBe(`0x${rs}${expected}`)
  })

  it('returns lowercase 0x hex, also when the signer omits the prefix', async () => {
    expect(await signWith(`${rs.toUpperCase()}1C`)).toBe(`0x${rs}1c`)
  })

  it.each([
    ['is undefined', undefined],
    ['is an object', { signature: `0x${rs}1b` }],
    ['is 64 bytes', `0x${rs}`],
    ['is 66 bytes', `0x${rs}1b00`],
    ['is not hex', `0x${'zz'.repeat(65)}`],
    ['is empty', ''],
    ['has an unknown v', `0x${rs}02`],
    ['has a v with an application offset', `0x${rs}3a`],
  ])('throws SigningError when the result %s', async (_, result) => {
    const error = await failure(signWith(result))
    expect(error).toBeInstanceOf(SigningError)
    expect((error as SigningError).cause).toBe(result)
  })

  it('the signature of a real key recovers the signer over the Tron-prefixed digest only', async () => {
    const signature = await signTypedData(fakeTronWeb(), [WALLET, typedData()])
    const prefixed = keccak256(concat([stringToHex(TRON_MESSAGE_HEADER), expectedDigest]))
    expect((await recoverAddress({ hash: prefixed, signature })).toLowerCase()).toBe(WALLET)
    // It is not a raw EIP-712 signature.
    expect((await recoverAddress({ hash: expectedDigest, signature })).toLowerCase()).not.toBe(
      WALLET,
    )
    expect(['1b', '1c']).toContain(signature.slice(-2))
  })
})
