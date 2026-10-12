import { BaseError, InvalidParamsRpcError, UserRejectedRequestError } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  BroadcastError,
  BroadcastIndeterminateError,
  SigningError,
  SimulationUnavailableError,
  TransactionBuildError,
  TransactionRevertedError,
  TronWebTransportError,
  invalidParams,
  messageOf,
  signingFailure,
} from '../src/errors.js'
import { hex, thrownForms } from './fakes.js'

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
    expect(messageOf('4142')).toBe('4142') // too short to be a message: 'AB'
    expect(messageOf('414243')).toBe('414243')
    expect(messageOf('41424344')).toBe('ABCD') // eight hex characters is the minimum
    expect(messageOf('0a414243')).toBe('0a414243') // decodes to a control character
    expect(messageOf('c3a9c3a9')).toBe('c3a9c3a9') // decodes to non-ASCII
    expect(messageOf('UkVWRVJU')).toBe('UkVWRVJU') // base64 is not guessed
    expect(messageOf('')).toBe('')
  })

  it('reads the text of a thrown string, an Error and an object with a message', () => {
    expect(messageOf('plain')).toBe('plain')
    expect(messageOf(new Error('boom'))).toBe('boom')
    expect(messageOf({ message: hex('node says no') })).toBe('node says no')
  })

  it.each([[undefined], [null], [5], [{}], [{ message: 5 }], [[]]])(
    'is empty when there is no text: %o',
    (value) => {
      expect(messageOf(value)).toBe('')
    },
  )
})

describe('error classes', () => {
  const cause = new Error('original')
  const cases = [
    ['TransactionRevertedError', new TransactionRevertedError('m', { cause })],
    ['SimulationUnavailableError', new SimulationUnavailableError('m', { cause })],
    ['TransactionBuildError', new TransactionBuildError('m', { cause })],
    ['SigningError', new SigningError('m', { cause })],
    ['BroadcastError', new BroadcastError('m', { cause })],
    ['BroadcastIndeterminateError', new BroadcastIndeterminateError('0xab', { cause })],
  ] as const

  it.each(cases)(
    '%s extends the base class, carries code -32003 and keeps the cause',
    (name, error) => {
      expect(error).toBeInstanceOf(BaseError)
      expect(error.name).toBe(name)
      expect(error).toBeInstanceOf(TronWebTransportError)
      expect(error.code).toBe(-32003)
      expect(error.cause).toBe(cause)
      expect(error.details).toBe(error.shortMessage)
    },
  )

  it('keeps a thrown string or object as the cause, verbatim', () => {
    const thrown = { message: 'object' }
    expect(new SigningError('m', { cause: 'text' }).cause).toBe('text')
    expect(new SigningError('m', { cause: thrown }).cause).toBe(thrown)
    expect(new SigningError('m').cause).toBeUndefined()
  })

  it('TransactionRevertedError carries reason and data', () => {
    const error = new TransactionRevertedError('m', {
      cause,
      reason: 'OUT_OF_ENERGY',
      data: '0x08c379a0',
    })
    expect(error.reason).toBe('OUT_OF_ENERGY')
    expect(error.data).toBe('0x08c379a0')
    expect(new TransactionRevertedError('m', { cause }).reason).toBeUndefined()
    expect(new TransactionRevertedError('m', { cause }).data).toBeUndefined()
  })

  it('BroadcastError carries the node code', () => {
    expect(new BroadcastError('m', { cause, nodeCode: 'SIGERROR' }).nodeCode).toBe('SIGERROR')
    expect(new BroadcastError('m', { cause }).nodeCode).toBeUndefined()
  })

  it('BroadcastIndeterminateError exposes the id three ways', () => {
    const id = `0x${'ab'.repeat(32)}` as const
    const error = new BroadcastIndeterminateError(id, { cause })
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
    'Rejected by user',
    'request denied by the user',
    'User reject',
  ]

  describe.each(refusals)('the refusal %j', (text) => {
    it.each(thrownForms(text))('thrown as %s is UserRejectedRequestError (4001)', (_, thrown) => {
      const error = signingFailure(thrown)
      expect(error).toBeInstanceOf(UserRejectedRequestError)
      expect((error as UserRejectedRequestError).code).toBe(4001)
      expect(error.cause === thrown || (error.cause as Error).cause === thrown).toBe(true)
    })
  })

  it.each([
    [{ code: 4001, message: 'nope' }],
    [{ code: 4001 }],
    [{ code: '4001' }],
    [{ error: { code: 4001 } }],
    [{ error: { code: '4001', message: 'x' } }],
  ])('maps %o to UserRejectedRequestError whatever the text', (thrown) => {
    expect(signingFailure(thrown)).toBeInstanceOf(UserRejectedRequestError)
  })

  it.each([
    'Transaction rejected',
    'rejected',
    'Rejected: user has no energy',
    'denied',
    'superuser rejects nothing',
    'The superuser denied it',
    'request cancelled by username',
  ])('node wording %j is not a user rejection', (text) => {
    expect(signingFailure(text)).toBeInstanceOf(SigningError)
    expect(signingFailure(new Error(text))).toBeInstanceOf(SigningError)
  })

  it.each([
    ['Invalid transaction'],
    [new Error('Private key does not match')],
    [{ code: 500 }],
    [{ error: { code: 500 } }],
    [{ error: 4001 }],
    [{ code: 5000 }],
    [undefined],
    [null],
    [4001],
  ])('maps %o to SigningError with the original as cause', (thrown) => {
    const error = signingFailure(thrown)
    expect(error).toBeInstanceOf(SigningError)
    expect(error.cause).toBe(thrown)
  })
})
