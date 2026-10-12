import { BaseError, InvalidParamsRpcError, UserRejectedRequestError, stringToHex } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  BroadcastError,
  BroadcastIndeterminateError,
  SigningError,
  SimulationUnavailableError,
  TransactionBuildError,
  TransactionRevertedError,
  guard,
  invalidParams,
  messageOf,
  signingFailure,
} from '../src/errors.js'

const hex = (text: string) => stringToHex(text).slice(2)

describe('messageOf (node message decoder)', () => {
  it('decodes a string that is entirely even-length hex of printable ASCII', () => {
    expect(messageOf(hex('REVERT opcode executed'))).toBe('REVERT opcode executed')
    expect(messageOf(hex('Validate signature error').toUpperCase())).toBe(
      'Validate signature error',
    )
  })

  it('keeps everything else as is', () => {
    expect(messageOf('REVERT opcode executed')).toBe('REVERT opcode executed')
    expect(messageOf('abc')).toBe('abc') // odd length
    expect(messageOf('0a41')).toBe('0a41') // decodes to a control character
    expect(messageOf('c3a9')).toBe('c3a9') // decodes to non-ASCII
    expect(messageOf('UkVWRVJU')).toBe('UkVWRVJU') // base64 is not guessed
    expect(messageOf('')).toBe('')
  })

  it('reads the text of a thrown string, an Error and an object with a message', () => {
    expect(messageOf('plain')).toBe('plain')
    expect(messageOf(new Error('boom'))).toBe('boom')
    expect(messageOf({ message: hex('node says no') })).toBe('node says no')
  })

  it('is empty when there is no text', () => {
    for (const value of [undefined, null, 5, {}, { message: 5 }, []])
      expect(messageOf(value)).toBe('')
  })
})

describe('error classes', () => {
  const cause = new Error('original')
  const cases = [
    ['TransactionRevertedError', new TransactionRevertedError('m', cause)],
    ['SimulationUnavailableError', new SimulationUnavailableError('m', cause)],
    ['TransactionBuildError', new TransactionBuildError('m', cause)],
    ['SigningError', new SigningError('m', cause)],
    ['BroadcastError', new BroadcastError('m', cause)],
    ['BroadcastIndeterminateError', new BroadcastIndeterminateError('0xab', cause)],
  ] as const

  it.each(cases)('%s extends viem BaseError, has no code and keeps the cause', (name, error) => {
    expect(error).toBeInstanceOf(BaseError)
    expect(error.name).toBe(name)
    expect('code' in error).toBe(false)
    expect(error.cause).toBe(cause)
    expect(error.details).toBe('original')
  })

  it('keeps a thrown string or object as the cause, verbatim', () => {
    const thrown = { message: 'object' }
    expect(new SigningError('m', 'text').cause).toBe('text')
    expect(new SigningError('m', 'text').details).toBe('text')
    expect(new SigningError('m', thrown).cause).toBe(thrown)
    expect(new SigningError('m').cause).toBeUndefined()
  })

  it('TransactionRevertedError carries reason and data', () => {
    const error = new TransactionRevertedError('m', cause, 'OUT_OF_ENERGY', '0x08c379a0')
    expect(error.reason).toBe('OUT_OF_ENERGY')
    expect(error.data).toBe('0x08c379a0')
    expect(new TransactionRevertedError('m', cause).reason).toBeUndefined()
    expect(new TransactionRevertedError('m', cause).data).toBeUndefined()
  })

  it('BroadcastError carries the node code', () => {
    expect(new BroadcastError('m', cause, 'SIGERROR').nodeCode).toBe('SIGERROR')
    expect(new BroadcastError('m', cause).nodeCode).toBeUndefined()
  })

  it('BroadcastIndeterminateError exposes the id three ways', () => {
    const id = `0x${'ab'.repeat(32)}` as const
    const error = new BroadcastIndeterminateError(id, cause)
    expect(error.transactionId).toBe(id)
    expect(error.data).toEqual({ transactionId: id })
    expect(error.message).toContain(id)
    expect(error.shortMessage).toMatch(
      /may have been accepted.*look the id up before sending again/i,
    )
  })
})

describe('invalidParams', () => {
  it('is a viem InvalidParamsRpcError (-32602) with the reason and the cause', () => {
    const cause = new Error('why')
    const error = invalidParams('bad `to`', cause)
    expect(error).toBeInstanceOf(InvalidParamsRpcError)
    expect(error.code).toBe(-32602)
    expect(error.details).toBe('bad `to`')
    expect((error.cause as Error).cause).toBe(cause)
  })
})

describe('signingFailure', () => {
  const refusals = [
    'Confirmation declined by user',
    'User rejected the request.',
    'user denied transaction signature',
    'User cancelled',
    'user canceled the request',
    'Cancelled by user',
    'canceled by the user',
  ]

  it.each(refusals)('maps the refusal %j to UserRejectedRequestError (4001)', (text) => {
    for (const thrown of [text, new Error(text), { message: text }]) {
      const error = signingFailure(thrown)
      expect(error).toBeInstanceOf(UserRejectedRequestError)
      expect((error as UserRejectedRequestError).code).toBe(4001)
      expect(error.cause === thrown || (error.cause as Error).cause === thrown).toBe(true)
    }
  })

  it('maps code 4001 to UserRejectedRequestError whatever the text', () => {
    expect(signingFailure({ code: 4001, message: 'nope' })).toBeInstanceOf(UserRejectedRequestError)
    expect(signingFailure({ code: 4001 })).toBeInstanceOf(UserRejectedRequestError)
  })

  it('maps every other thrown value to SigningError with the original as cause', () => {
    for (const thrown of [
      'Invalid transaction',
      new Error('Private key does not match'),
      { code: 500 },
      undefined,
      null,
      4001,
    ]) {
      const error = signingFailure(thrown)
      expect(error).toBeInstanceOf(SigningError)
      expect(error.cause).toBe(thrown)
    }
  })
})

describe('guard', () => {
  it('returns the value of a sync or async call', async () => {
    await expect(
      guard(
        () => 1,
        () => new Error('never'),
      ),
    ).resolves.toBe(1)
    await expect(
      guard(
        () => Promise.resolve(2),
        () => new Error('never'),
      ),
    ).resolves.toBe(2)
  })

  it.each([
    ['a string', 'text'],
    ['an object', { message: 'obj' }],
    ['an Error', new Error('err')],
  ])('converts %s thrown synchronously or asynchronously', async (_, thrown) => {
    const wrap = (cause: unknown) => new SigningError('wrapped', cause)
    const sync = guard(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- wallets throw non-errors
      throw thrown
    }, wrap)
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- wallets reject with non-errors
    const asynchronous = guard(() => Promise.reject(thrown), wrap)
    for (const promise of [sync, asynchronous]) {
      const error = await promise.catch((e: unknown) => e)
      expect(error).toBeInstanceOf(SigningError)
      expect((error as SigningError).cause).toBe(thrown)
    }
  })
})
