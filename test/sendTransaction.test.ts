import { InvalidParamsRpcError, UserRejectedRequestError } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  BroadcastError,
  BroadcastIndeterminateError,
  SigningError,
  SimulationUnavailableError,
  TransactionBuildError,
  TransactionRevertedError,
} from '../src/errors.js'
import { sendTransaction } from '../src/sendTransaction.js'
import {
  CONTRACT,
  CONTRACT_41,
  CONTRACT_BASE58,
  type FakeTronWeb,
  NONE,
  OTHER,
  WALLET,
  WALLET_41,
  WALLET_BASE58,
  callCounts,
  failure,
  fakeTronWeb,
  hex,
  rejection,
  thrownForms,
} from './fakes.js'

const FEE_LIMIT = 300_000_000
const DATA = '0xA9059cbb00'
const send = (tronWeb: FakeTronWeb, tx: unknown) => sendTransaction(tronWeb, FEE_LIMIT, [tx])

async function expectInvalidParams(tx: unknown, tronWeb = fakeTronWeb()) {
  const error = await failure(send(tronWeb, tx))
  expect(error).toBeInstanceOf(InvalidParamsRpcError)
  expect((error as InvalidParamsRpcError).code).toBe(-32602)
  expect(callCounts(tronWeb)).toEqual(NONE)
  return error as InvalidParamsRpcError
}

describe('1. validate', () => {
  it.each([
    [undefined],
    [[]],
    [['0xabc']],
    [[null]],
    [[[{ to: CONTRACT }]]],
    ['text'],
    [{ to: CONTRACT }],
  ])('rejects params whose first element is not a plain object: %o', async (params) => {
    const tronWeb = fakeTronWeb()
    expect(await failure(sendTransaction(tronWeb, FEE_LIMIT, params))).toBeInstanceOf(
      InvalidParamsRpcError,
    )
    expect(callCounts(tronWeb)).toEqual(NONE)
  })

  it.each([[{ data: DATA }], [{ to: null, data: DATA }]])(
    'rejects contract creation: %o',
    async (tx) => {
      expect((await expectInvalidParams(tx)).details).toMatch(/contract creation/i)
    },
  )

  it.each([['0x1234'], ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u'], [5], [{}], ['']])(
    'rejects a malformed `to`: %o',
    async (to) => {
      await expectInvalidParams({ to, data: DATA })
    },
  )

  it.each([
    ['0x', CONTRACT],
    ['base58', CONTRACT_BASE58],
    ['41-hex', CONTRACT_41],
  ])('accepts `to` in %s form', async (_, to) => {
    const tronWeb = fakeTronWeb()
    await send(tronWeb, { to, data: DATA })
    expect(tronWeb.transactionBuilder.triggerSmartContract.mock.calls[0]?.[0]).toBe(CONTRACT_BASE58)
  })

  it('accepts `input`, and `data` with `input` when they are equal ignoring case', async () => {
    for (const tx of [
      { input: DATA },
      { data: DATA, input: DATA.toLowerCase() },
      { data: DATA, input: null },
    ]) {
      const tronWeb = fakeTronWeb()
      await send(tronWeb, { to: CONTRACT, ...tx })
      expect(tronWeb.transactionBuilder.triggerSmartContract.mock.calls[0]?.[2].input).toBe(
        DATA.slice(2),
      )
    }
  })

  it('rejects `data` and `input` that differ', async () => {
    await expectInvalidParams({ to: CONTRACT, data: DATA, input: '0xa9059cbb01' })
    await expectInvalidParams({ to: CONTRACT, data: DATA, input: '0x' })
  })

  it.each([['a9059cbb'], ['0xabc'], ['0xzz'], [5], [{}], ['0x 12'], ['0X12']])(
    'rejects calldata that is not 0x-prefixed even-length hex: %o',
    async (data) => {
      await expectInvalidParams({ to: CONTRACT, data })
      await expectInvalidParams({ to: CONTRACT, input: data })
    },
  )

  it.each([
    ['a 0x quantity', '0x2a', 42],
    ['a bigint', 42n, 42],
    ['a number', 42, 42],
    ['the largest safe integer', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  ])('accepts `value` as %s, in SUN and unscaled', async (_, value, expected) => {
    const tronWeb = fakeTronWeb()
    await send(tronWeb, { to: CONTRACT, data: DATA, value })
    expect(tronWeb.transactionBuilder.triggerSmartContract.mock.calls[0]?.[2].callValue).toBe(
      expected,
    )
    expect(tronWeb.transactionBuilder.triggerConstantContract.mock.calls[0]?.[2].callValue).toBe(
      expected,
    )
  })

  it.each([
    ['42'],
    ['0x'],
    ['0xzz'],
    [-1],
    [-1n],
    [1.5],
    [2 ** 53],
    [2n ** 53n],
    ['0x20000000000000'],
    [NaN],
    [{}],
    [true],
  ])('rejects `value` %o', async (value) => {
    await expectInvalidParams({ to: CONTRACT, data: DATA, value })
    await expectInvalidParams({ to: CONTRACT, value })
  })

  it.each([[-1], [1.5], ['2'], ['0x2'], [2n], [2 ** 53], [{}]])(
    'rejects `permissionId` %o',
    async (permissionId) => {
      await expectInvalidParams({ to: CONTRACT, data: DATA, permissionId })
    },
  )
})

describe('2. sender', () => {
  it('rejects when the wallet has no address', async () => {
    const tronWeb = fakeTronWeb()
    tronWeb.defaultAddress = { hex: false, base58: false }
    await expectInvalidParams({ to: CONTRACT, data: DATA }, tronWeb)
  })

  it.each([[OTHER], ['0x1234'], ['nobody'], [5]])(
    'rejects a `from` that is not the wallet address: %o',
    async (from) => {
      await expectInvalidParams({ from, to: CONTRACT, data: DATA })
    },
  )

  it.each([
    [WALLET],
    [WALLET.toUpperCase().replace('0X', '0x')],
    [WALLET_41],
    [WALLET_BASE58],
    [null],
  ])('accepts `from` %o', async (from) => {
    const tronWeb = fakeTronWeb()
    await send(tronWeb, { from, to: CONTRACT, data: DATA })
    expect(tronWeb.transactionBuilder.triggerSmartContract.mock.calls[0]?.[4]).toBe(WALLET_BASE58)
  })

  it('reads the wallet address once and uses that value for the build and the simulation', async () => {
    const tronWeb = fakeTronWeb()
    let reads = 0
    Object.defineProperty(tronWeb, 'defaultAddress', {
      // The wallet switches account right after the first read.
      get: () => (reads++ === 0 ? { hex: WALLET_41, base58: WALLET_BASE58 } : { hex: CONTRACT_41 }),
    })
    await send(tronWeb, { from: WALLET, to: CONTRACT, data: DATA })
    expect(reads).toBe(1)
    expect(tronWeb.transactionBuilder.triggerSmartContract.mock.calls[0]?.[4]).toBe(WALLET_BASE58)
    expect(tronWeb.transactionBuilder.triggerConstantContract.mock.calls[0]?.[4]).toBe(
      WALLET_BASE58,
    )
  })
})

describe('3. build — contract call', () => {
  it('forwards the calldata byte for byte and passes the fee limit', async () => {
    const tronWeb = fakeTronWeb()
    await send(tronWeb, { to: CONTRACT, data: DATA })
    expect(tronWeb.transactionBuilder.triggerSmartContract).toHaveBeenCalledExactlyOnceWith(
      CONTRACT_BASE58,
      '',
      { feeLimit: FEE_LIMIT, input: 'A9059cbb00' },
      [],
      WALLET_BASE58,
    )
  })

  it('passes callValue only when value > 0, and permissionId when given', async () => {
    const tronWeb = fakeTronWeb()
    await send(tronWeb, { to: CONTRACT, data: DATA, value: '0x0' })
    expect(tronWeb.transactionBuilder.triggerSmartContract.mock.calls[0]?.[2]).toEqual({
      feeLimit: FEE_LIMIT,
      input: 'A9059cbb00',
    })
    await send(tronWeb, { to: CONTRACT, data: DATA, value: 7n, permissionId: 2 })
    expect(tronWeb.transactionBuilder.triggerSmartContract.mock.calls[1]?.[2]).toEqual({
      feeLimit: FEE_LIMIT,
      input: 'A9059cbb00',
      callValue: 7,
      permissionId: 2,
    })
  })

  it('ignores gas, fee, nonce, chain and type fields', async () => {
    const plain = fakeTronWeb()
    const noisy = fakeTronWeb()
    await send(plain, { to: CONTRACT, data: DATA })
    await send(noisy, {
      to: CONTRACT,
      data: DATA,
      gas: '0x5208',
      gasPrice: '0x1',
      maxFeePerGas: '0x1',
      maxPriorityFeePerGas: '0x1',
      nonce: '0x7',
      chainId: '0x1',
      type: '0x2',
      accessList: [],
    })
    expect(noisy.transactionBuilder.triggerSmartContract.mock.calls).toEqual(
      plain.transactionBuilder.triggerSmartContract.mock.calls,
    )
  })

  it.each(thrownForms('Invalid feeLimit provided'))(
    'converts %s thrown by the builder to TransactionBuildError',
    async (_, thrown) => {
      const tronWeb = fakeTronWeb()
      tronWeb.transactionBuilder.triggerSmartContract.mockImplementationOnce(rejection(thrown))
      const error = await failure(send(tronWeb, { to: CONTRACT, data: DATA }))
      expect(error).toBeInstanceOf(TransactionBuildError)
      expect((error as TransactionBuildError).cause).toBe(thrown)
      expect((error as TransactionBuildError).message).toContain('Invalid feeLimit provided')
      expect(callCounts(tronWeb)).toEqual({ ...NONE, build: 1 })
    },
  )

  it('converts a synchronous throw of the builder as well', async () => {
    const tronWeb = fakeTronWeb()
    const error = await failure(sendTransaction(tronWeb, 0, [{ to: CONTRACT, data: DATA }]))
    expect(error).toBeInstanceOf(TransactionBuildError)
    expect(((error as TransactionBuildError).cause as Error).message).toBe(
      'Invalid feeLimit provided',
    )
  })

  it.each([
    ['is not an object', undefined],
    ['is null', null],
    ['has no transaction', { result: { result: true } }],
    ['has no result', { transaction: { txID: 'ab'.repeat(32) } }],
    [
      'reports result !== true',
      { result: { result: false }, transaction: { txID: 'ab'.repeat(32) } },
    ],
    [
      'reports a truthy non-boolean result',
      { result: { result: 1 }, transaction: { txID: 'ab'.repeat(32) } },
    ],
    ['has a transaction without txID', { result: { result: true }, transaction: {} }],
    ['has a malformed txID', { result: { result: true }, transaction: { txID: 'zz' } }],
  ])('throws TransactionBuildError when the answer %s', async (_, answer) => {
    const tronWeb = fakeTronWeb()
    tronWeb.transactionBuilder.triggerSmartContract.mockResolvedValueOnce(answer)
    const error = await failure(send(tronWeb, { to: CONTRACT, data: DATA }))
    expect(error).toBeInstanceOf(TransactionBuildError)
    expect((error as TransactionBuildError).cause).toBe(answer)
    expect(callCounts(tronWeb)).toEqual({ ...NONE, build: 1 })
  })

  it('throws TransactionBuildError for a transaction that cannot be copied', async () => {
    const tronWeb = fakeTronWeb()
    const answer = {
      result: { result: true },
      transaction: { txID: 'ab'.repeat(32), toJSON: () => 'x' },
    }
    tronWeb.transactionBuilder.triggerSmartContract.mockResolvedValueOnce(answer)
    const error = await failure(send(tronWeb, { to: CONTRACT, data: DATA }))
    expect(error).toBeInstanceOf(TransactionBuildError)
    expect(callCounts(tronWeb)).toEqual({ ...NONE, build: 1 })
  })

  it('decodes the node message of a refused build', async () => {
    const tronWeb = fakeTronWeb()
    tronWeb.transactionBuilder.triggerSmartContract.mockResolvedValueOnce({
      result: {
        code: 'CONTRACT_VALIDATE_ERROR',
        message: hex('No contract or not a valid smart contract'),
      },
    })
    const error = await failure(send(tronWeb, { to: CONTRACT, data: DATA }))
    expect((error as TransactionBuildError).shortMessage).toContain(
      'No contract or not a valid smart contract',
    )
  })
})

describe('3. build — TRX transfer', () => {
  it.each([[undefined], ['0x'], [null]])(
    'calldata %o with a positive value is a transfer',
    async (data) => {
      const tronWeb = fakeTronWeb()
      const id = await send(tronWeb, { to: CONTRACT, data, value: '0x0f4240', permissionId: 3 })
      expect(tronWeb.transactionBuilder.sendTrx).toHaveBeenCalledExactlyOnceWith(
        CONTRACT_BASE58,
        1_000_000,
        WALLET_BASE58,
        { permissionId: 3 },
      )
      expect(callCounts(tronWeb)).toEqual({
        build: 0,
        simulate: 0,
        transfer: 1,
        sign: 1,
        broadcast: 1,
      })
      expect(id).toMatch(/^0x[0-9a-f]{64}$/)
    },
  )

  it('passes empty options without permissionId', async () => {
    const tronWeb = fakeTronWeb()
    await send(tronWeb, { to: CONTRACT, value: 1 })
    expect(tronWeb.transactionBuilder.sendTrx.mock.calls[0]?.[3]).toEqual({})
  })

  it.each([[undefined], [0], ['0x0'], [0n], [null]])(
    'rejects empty calldata with value %o',
    async (value) => {
      await expectInvalidParams({ to: CONTRACT, value })
      await expectInvalidParams({ to: CONTRACT, data: '0x', value })
    },
  )

  it.each(thrownForms('Unable to get params: connect ECONNREFUSED'))(
    'converts %s thrown by sendTrx to TransactionBuildError',
    async (_, thrown) => {
      const tronWeb = fakeTronWeb()
      tronWeb.transactionBuilder.sendTrx.mockImplementationOnce(rejection(thrown))
      const error = await failure(send(tronWeb, { to: CONTRACT, value: 1 }))
      expect(error).toBeInstanceOf(TransactionBuildError)
      expect((error as TransactionBuildError).cause).toBe(thrown)
      expect(callCounts(tronWeb)).toEqual({ ...NONE, transfer: 1 })
    },
  )

  it('converts the builder refusing a transfer to oneself', async () => {
    const tronWeb = fakeTronWeb()
    const error = await failure(send(tronWeb, { to: WALLET, value: 1 }))
    expect(error).toBeInstanceOf(TransactionBuildError)
    expect((error as TransactionBuildError).message).toContain(
      'Cannot transfer TRX to the same account',
    )
    expect(callCounts(tronWeb)).toEqual({ ...NONE, transfer: 1 })
  })

  it.each([[undefined], [null], [{}], [{ txID: 5 }], [{ txID: '' }], ['txid']])(
    'throws TransactionBuildError for a result without txID: %o',
    async (answer) => {
      const tronWeb = fakeTronWeb()
      tronWeb.transactionBuilder.sendTrx.mockResolvedValueOnce(answer)
      const error = await failure(send(tronWeb, { to: CONTRACT, value: 1 }))
      expect(error).toBeInstanceOf(TransactionBuildError)
      expect(callCounts(tronWeb)).toEqual({ ...NONE, transfer: 1 })
    },
  )
})

describe('3. the built transaction must match the request', () => {
  type Value = Record<string, unknown>
  interface Built {
    raw_data: { contract: { type: string; parameter?: { value: Value } }[] }
  }
  const valueOf = (tx: Built) => (tx.raw_data.contract[0]?.parameter as { value: Value }).value

  /** Lets the fake build, then alters the transaction the way a hostile node could. */
  const build = async (kind: 'call' | 'transfer', alter: (tx: Built) => void) => {
    const tronWeb = fakeTronWeb()
    if (kind === 'call') {
      const real = tronWeb.transactionBuilder.triggerSmartContract.getMockImplementation()
      tronWeb.transactionBuilder.triggerSmartContract.mockImplementationOnce(async (...args) => {
        const answer = (await real?.(...args)) as { transaction: Built }
        alter(answer.transaction)
        return answer
      })
    } else {
      const real = tronWeb.transactionBuilder.sendTrx.getMockImplementation()
      tronWeb.transactionBuilder.sendTrx.mockImplementationOnce(async (...args) => {
        const answer = (await real?.(...args)) as Built
        alter(answer)
        return answer
      })
    }
    const tx = kind === 'call' ? { to: CONTRACT, data: DATA, value: 7 } : { to: CONTRACT, value: 7 }
    return { tronWeb, result: await send(tronWeb, tx).catch((e: unknown) => e) }
  }

  const shape: [string, (tx: Built) => void][] = [
    ['no raw_data', (tx) => delete (tx as Partial<Built>).raw_data],
    ['no contract entry', (tx) => (tx.raw_data.contract = [])],
    [
      'two contract entries',
      (tx) =>
        tx.raw_data.contract.push({
          ...tx.raw_data.contract[0],
        } as Built['raw_data']['contract'][0]),
    ],
    ['a contract list that is not a list', (tx) => Object.assign(tx.raw_data, { contract: {} })],
    ['an entry without parameter', (tx) => delete tx.raw_data.contract[0]?.parameter],
    ['another owner', (tx) => (valueOf(tx).owner_address = CONTRACT_41)],
    ['a malformed owner', (tx) => (valueOf(tx).owner_address = '41zz')],
  ]
  const swapped: Record<'call' | 'transfer', [string, (tx: Built) => void][]> = {
    call: [
      ...shape,
      [
        'another contract type',
        (tx) => Object.assign(tx.raw_data.contract[0] ?? {}, { type: 'TransferContract' }),
      ],
      ['another contract', (tx) => (valueOf(tx).contract_address = WALLET_41)],
      ['other calldata', (tx) => (valueOf(tx).data = 'a9059cbb01')],
      ['longer calldata', (tx) => (valueOf(tx).data = 'a9059cbb0000')],
      ['no calldata', (tx) => delete valueOf(tx).data],
      ['another call value', (tx) => (valueOf(tx).call_value = 8)],
      ['no call value', (tx) => delete valueOf(tx).call_value],
      ['a call value as a string', (tx) => (valueOf(tx).call_value = '7')],
    ],
    transfer: [
      ...shape,
      [
        'another contract type',
        (tx) => Object.assign(tx.raw_data.contract[0] ?? {}, { type: 'TriggerSmartContract' }),
      ],
      ['another recipient', (tx) => (valueOf(tx).to_address = WALLET_41)],
      ['another amount', (tx) => (valueOf(tx).amount = 7_000_000)],
      ['no amount', (tx) => delete valueOf(tx).amount],
    ],
  }

  describe.each(['call', 'transfer'] as const)('%s', (kind) => {
    it.each(swapped[kind])(
      '%s → TransactionBuildError, nothing simulated, signed or broadcast',
      async (_, alter) => {
        const { tronWeb, result } = await build(kind, alter)
        expect(result).toBeInstanceOf(TransactionBuildError)
        expect((result as TransactionBuildError).shortMessage).toMatch(/does not match the request/)
        expect(callCounts(tronWeb)).toEqual({
          ...NONE,
          [kind === 'call' ? 'build' : 'transfer']: 1,
        })
      },
    )

    it('accepts addresses in base58 or 0x form and hex in another case', async () => {
      const { result } = await build(kind, (tx) => {
        const value = valueOf(tx)
        value.owner_address = WALLET_BASE58
        if (kind === 'call')
          Object.assign(value, { contract_address: CONTRACT, data: 'a9059CBB00' })
        else value.to_address = CONTRACT_BASE58
      })
      expect(result).toMatch(/^0x[0-9a-f]{64}$/)
    })
  })

  it('an absent call value equals a requested value of zero', async () => {
    const tronWeb = fakeTronWeb()
    expect(await send(tronWeb, { to: CONTRACT, data: DATA })).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('a call value added to a call that sends none is refused', async () => {
    const tronWeb = fakeTronWeb()
    const real = tronWeb.transactionBuilder.triggerSmartContract.getMockImplementation()
    tronWeb.transactionBuilder.triggerSmartContract.mockImplementationOnce(async (...args) => {
      const answer = (await real?.(...args)) as { transaction: Built }
      valueOf(answer.transaction).call_value = 1_000_000
      return answer
    })
    expect(await failure(send(tronWeb, { to: CONTRACT, data: DATA }))).toBeInstanceOf(
      TransactionBuildError,
    )
    expect(callCounts(tronWeb)).toEqual({ ...NONE, build: 1 })
  })
})

describe('4. simulate', () => {
  const SIMULATED = { ...NONE, build: 1, simulate: 1 }
  const simulate = async (answer: unknown, thrown = false) => {
    const tronWeb = fakeTronWeb()
    if (thrown)
      tronWeb.transactionBuilder.triggerConstantContract.mockImplementationOnce(rejection(answer))
    else tronWeb.transactionBuilder.triggerConstantContract.mockResolvedValueOnce(answer)
    const error = await failure(send(tronWeb, { to: CONTRACT, data: DATA }))
    // Nothing reaches the signer or the node after a failed or unavailable simulation.
    expect(callCounts(tronWeb)).toEqual(SIMULATED)
    return error
  }

  it('runs the same call without a fee limit', async () => {
    const tronWeb = fakeTronWeb()
    await send(tronWeb, { to: CONTRACT, data: DATA, value: 7, permissionId: 2 })
    expect(tronWeb.transactionBuilder.triggerConstantContract).toHaveBeenCalledExactlyOnceWith(
      CONTRACT_BASE58,
      '',
      { input: 'A9059cbb00', callValue: 7, permissionId: 2 },
      [],
      WALLET_BASE58,
    )
  })

  it.each(thrownForms('REVERT opcode executed'))(
    'a thrown revert (%s) is TransactionRevertedError without data',
    async (_, thrown) => {
      const error = await simulate(thrown, true)
      expect(error).toBeInstanceOf(TransactionRevertedError)
      expect((error as TransactionRevertedError).cause).toBe(thrown)
      expect((error as TransactionRevertedError).data).toBeUndefined()
      expect((error as TransactionRevertedError).reason).toBeUndefined()
    },
  )

  it('a returned revert message carries the revert bytes', async () => {
    const answer = {
      result: { result: true, message: hex('REVERT opcode executed') },
      constant_result: ['08c379a0' + '00'.repeat(4)],
      transaction: { ret: [{ ret: 'FAILED' }] },
    }
    const error = await simulate(answer)
    expect(error).toBeInstanceOf(TransactionRevertedError)
    expect((error as TransactionRevertedError).data).toBe('0x08c379a000000000')
    expect((error as TransactionRevertedError).cause).toBe(answer)
    expect((error as TransactionRevertedError).shortMessage).toContain('REVERT opcode executed')
  })

  it.each([
    [
      'ret FAILED without a message',
      { result: { result: true }, transaction: { ret: [{ ret: 'FAILED' }] } },
    ],
    ['a revert message with result false', { result: { result: false, message: 'Revert' } }],
    [
      'unusable revert bytes',
      {
        result: { result: true },
        constant_result: ['zz'],
        transaction: { ret: [{ ret: 'FAILED' }] },
      },
    ],
    [
      'empty revert bytes',
      {
        result: { result: true },
        constant_result: [''],
        transaction: { ret: [{ ret: 'FAILED' }] },
      },
    ],
  ])('%s is TransactionRevertedError without data', async (_, answer) => {
    const error = await simulate(answer)
    expect(error).toBeInstanceOf(TransactionRevertedError)
    expect((error as TransactionRevertedError).data).toBeUndefined()
  })

  it.each([
    ['thrown text', 'OUT_OF_ENERGY', true],
    ['a thrown Error', new Error('Out of energy while executing'), true],
    ['a returned message', { result: { result: true, message: hex('out-of-energy') } }, false],
    [
      'a failed ret with an energy message',
      {
        result: { result: true, message: 'OutOfEnergy' },
        transaction: { ret: [{ ret: 'FAILED' }] },
      },
      false,
    ],
  ])(
    'out of energy as %s is TransactionRevertedError with reason OUT_OF_ENERGY',
    async (_, answer, thrown) => {
      const error = await simulate(answer, thrown)
      expect(error).toBeInstanceOf(TransactionRevertedError)
      expect((error as TransactionRevertedError).reason).toBe('OUT_OF_ENERGY')
    },
  )

  it.each([
    ...thrownForms('connect ECONNREFUSED 127.0.0.1:8090').map(
      ([name, value]) => [`thrown ${name}`, value, true] as const,
    ),
    ['a thrown HTTP 429', { status: 429, message: 'Request failed with status code 429' }, true],
    ['a thrown undefined', undefined, true],
    ['an undefined answer', undefined, false],
    ['a null answer', null, false],
    ['a text answer', 'ok', false],
    ['an empty answer', {}, false],
    ['result false', { result: { result: false } }, false],
    ['a truthy non-boolean result', { result: { result: 'true' } }, false],
    [
      'an unexplained message',
      { result: { result: true, message: hex('CONTRACT_VALIDATE_ERROR') } },
      false,
    ],
    ['an empty message', { result: { result: true, message: '' } }, false],
  ] as const)('%s is SimulationUnavailableError', async (_, answer, thrown) => {
    const error = await simulate(answer, thrown)
    expect(error).toBeInstanceOf(SimulationUnavailableError)
    expect((error as SimulationUnavailableError).cause).toBe(answer)
  })

  it.each([
    ['without ret', { result: { result: true } }],
    ['with an empty ret entry', { result: { result: true }, transaction: { ret: [{}] } }],
    ['with ret SUCCESS', { result: { result: true }, transaction: { ret: [{ ret: 'SUCCESS' }] } }],
    ['with a malformed ret', { result: { result: true }, transaction: { ret: 'x' } }],
    [
      'with a ret other than FAILED',
      { result: { result: true }, transaction: { ret: [{ ret: 'SUCESS' }] } },
    ],
  ])('a successful simulation %s lets the send continue', async (_, answer) => {
    const tronWeb = fakeTronWeb()
    tronWeb.transactionBuilder.triggerConstantContract.mockResolvedValueOnce(answer)
    await send(tronWeb, { to: CONTRACT, data: DATA })
    expect(callCounts(tronWeb)).toEqual({
      build: 1,
      simulate: 1,
      transfer: 0,
      sign: 1,
      broadcast: 1,
    })
  })
})

describe('5. sign', () => {
  const SIGNED = { build: 1, simulate: 1, transfer: 0, sign: 1, broadcast: 0 }

  it('signs the built transaction object', async () => {
    const tronWeb = fakeTronWeb()
    await send(tronWeb, { to: CONTRACT, data: DATA })
    const built = (await tronWeb.transactionBuilder.triggerSmartContract.mock.results[0]
      ?.value) as {
      transaction: object
    }
    expect(tronWeb.trx.sign).toHaveBeenCalledExactlyOnceWith(built.transaction)
  })

  it.each(thrownForms('Confirmation declined by user'))(
    'a refusal thrown as %s is UserRejectedRequestError (4001)',
    async (_, thrown) => {
      const tronWeb = fakeTronWeb()
      tronWeb.trx.sign.mockImplementationOnce(rejection(thrown))
      const error = await failure(send(tronWeb, { to: CONTRACT, data: DATA }))
      expect(error).toBeInstanceOf(UserRejectedRequestError)
      expect((error as UserRejectedRequestError).code).toBe(4001)
      expect(callCounts(tronWeb)).toEqual(SIGNED)
    },
  )

  it('a thrown code 4001 is UserRejectedRequestError', async () => {
    const tronWeb = fakeTronWeb()
    tronWeb.trx.sign.mockImplementationOnce(rejection({ code: 4001, message: 'x' }))
    expect(await failure(send(tronWeb, { to: CONTRACT, data: DATA }))).toBeInstanceOf(
      UserRejectedRequestError,
    )
    expect(callCounts(tronWeb)).toEqual(SIGNED)
  })

  it.each(thrownForms('Private key does not match address in transaction'))(
    'any other failure thrown as %s is SigningError',
    async (_, thrown) => {
      const tronWeb = fakeTronWeb()
      tronWeb.trx.sign.mockImplementationOnce(rejection(thrown))
      const error = await failure(send(tronWeb, { to: CONTRACT, data: DATA }))
      expect(error).toBeInstanceOf(SigningError)
      expect((error as SigningError).cause).toBe(thrown)
      expect(callCounts(tronWeb)).toEqual(SIGNED)
    },
  )

  it.each([
    ['is undefined', () => undefined],
    ['is null', () => null],
    ['is a string', () => '0xsignature'],
    ['has no signature', (tx: object) => ({ ...tx })],
    ['has an empty signature array', (tx: object) => ({ ...tx, signature: [] })],
    ['has a signature that is not an array', (tx: object) => ({ ...tx, signature: 'ab' })],
    ['has another txID', (tx: object) => ({ ...tx, txID: 'cd'.repeat(32), signature: ['ab'] })],
    [
      'has a txID in another case',
      (tx: { txID: string }) => ({ ...tx, txID: tx.txID.toUpperCase(), signature: ['ab'] }),
    ],
    ['has no txID', () => ({ signature: ['ab'] })],
  ])('throws SigningError and broadcasts nothing when the result %s', async (_, result) => {
    for (const tx of [
      { to: CONTRACT, data: DATA },
      { to: CONTRACT, value: 1 },
    ]) {
      const tronWeb = fakeTronWeb()
      tronWeb.trx.sign.mockImplementationOnce((input) =>
        Promise.resolve(result(input as { txID: string })),
      )
      const error = await failure(send(tronWeb, tx))
      expect(error).toBeInstanceOf(SigningError)
      expect(callCounts(tronWeb).sign).toBe(1)
      expect(callCounts(tronWeb).broadcast).toBe(0)
    }
  })
})

describe('5. the signer cannot change what is broadcast', () => {
  const tx = { to: CONTRACT, data: DATA }
  const SIGNATURE = 'ab'.repeat(65)
  const builtBy = async (tronWeb: FakeTronWeb) =>
    structuredClone(
      (
        (await tronWeb.transactionBuilder.triggerSmartContract.mock.results[0]?.value) as {
          transaction: { txID: string; raw_data: object; raw_data_hex: string }
        }
      ).transaction,
    )

  it.each([
    ['txID', (t: Record<string, unknown>) => (t.txID = 'cd'.repeat(32))],
    [
      'txID, raw_data and raw_data_hex',
      (t: Record<string, unknown>) =>
        Object.assign(t, { txID: 'cd'.repeat(32), raw_data: {}, raw_data_hex: 'ff' }),
    ],
  ])(
    'a signer that mutates %s in place and returns the object → SigningError, no broadcast',
    async (_, mutate) => {
      const tronWeb = fakeTronWeb()
      tronWeb.trx.sign.mockImplementationOnce((input) => {
        mutate(input as Record<string, unknown>)
        return Promise.resolve(Object.assign(input as object, { signature: [SIGNATURE] }))
      })
      expect(await failure(send(tronWeb, tx))).toBeInstanceOf(SigningError)
      expect(callCounts(tronWeb).broadcast).toBe(0)
    },
  )

  it('a signer that mutates raw_data in place but keeps txID: the built bytes are broadcast', async () => {
    const tronWeb = fakeTronWeb()
    tronWeb.trx.sign.mockImplementationOnce((input) =>
      Promise.resolve(
        Object.assign(input as object, {
          raw_data: { contract: [] },
          raw_data_hex: 'ff',
          signature: [SIGNATURE],
        }),
      ),
    )
    // The builder's own object is what the signer mutated; compare with a build of the same request.
    const reference = fakeTronWeb()
    await send(reference, tx)
    await send(tronWeb, tx)
    expect(tronWeb.trx.sendRawTransaction).toHaveBeenCalledExactlyOnceWith({
      ...(await builtBy(reference)),
      signature: [SIGNATURE],
    })
  })

  it('a signer that returns another object with the same txID: the built bytes are broadcast', async () => {
    const tronWeb = fakeTronWeb()
    tronWeb.trx.sign.mockImplementationOnce((input) =>
      Promise.resolve({
        txID: (input as { txID: string }).txID,
        raw_data: { contract: [{ type: 'TransferContract' }] },
        raw_data_hex: 'ff',
        visible: true,
        extra: 1,
        signature: [SIGNATURE],
      }),
    )
    await send(tronWeb, tx)
    expect(tronWeb.trx.sendRawTransaction).toHaveBeenCalledExactlyOnceWith({
      ...(await builtBy(tronWeb)),
      signature: [SIGNATURE],
    })
  })

  it.each([
    ['null', [null]],
    ['a number', [5]],
    ['64 bytes', ['ab'.repeat(64)]],
    ['66 bytes', ['ab'.repeat(66)]],
    ['not hex', ['zz'.repeat(65)]],
    ['one good and one bad entry', [SIGNATURE, 'ab']],
  ])('a signature entry that is %s → SigningError, no broadcast', async (_, signature) => {
    const tronWeb = fakeTronWeb()
    tronWeb.trx.sign.mockImplementationOnce((input) =>
      Promise.resolve({ ...(input as object), signature }),
    )
    expect(await failure(send(tronWeb, tx))).toBeInstanceOf(SigningError)
    expect(callCounts(tronWeb).broadcast).toBe(0)
  })

  it.each([[[SIGNATURE]], [[`0x${SIGNATURE}`]], [[SIGNATURE, SIGNATURE.toUpperCase()]]])(
    'accepts 65-byte hex signatures: %o',
    async (signature) => {
      const tronWeb = fakeTronWeb()
      tronWeb.trx.sign.mockImplementationOnce((input) =>
        Promise.resolve({ ...(input as object), signature }),
      )
      await send(tronWeb, tx)
      expect(tronWeb.trx.sendRawTransaction.mock.calls[0]?.[0]).toMatchObject({ signature })
    },
  )
})

describe('6. broadcast and 7. return', () => {
  const SENT = { build: 1, simulate: 1, transfer: 0, sign: 1, broadcast: 1 }
  const txIdOf = async (tronWeb: FakeTronWeb) =>
    ((await tronWeb.trx.sign.mock.results[0]?.value) as { txID: string }).txID

  it('broadcasts the built transaction with the returned signatures and returns 0x + txID without waiting', async () => {
    const tronWeb = fakeTronWeb()
    const id = await send(tronWeb, { to: CONTRACT, data: DATA })
    const signed: unknown = await tronWeb.trx.sign.mock.results[0]?.value
    expect(tronWeb.trx.sendRawTransaction).toHaveBeenCalledExactlyOnceWith(signed)
    expect(id).toBe(`0x${await txIdOf(tronWeb)}`)
    expect(callCounts(tronWeb)).toEqual(SENT)
  })

  it('returns the id in lowercase', async () => {
    const tronWeb = fakeTronWeb()
    const real = tronWeb.transactionBuilder.sendTrx.getMockImplementation()
    tronWeb.transactionBuilder.sendTrx.mockImplementationOnce(async (...args) => {
      const built = (await real?.(...args)) as { txID: string }
      return { ...built, txID: built.txID.toUpperCase() }
    })
    tronWeb.trx.sign.mockImplementationOnce((input) =>
      Promise.resolve({ ...(input as object), signature: ['ab'.repeat(65)] }),
    )
    const id = await send(tronWeb, { to: CONTRACT, value: 1 })
    expect(id).toMatch(/^0x[0-9a-f]{64}$/)
    expect(tronWeb.trx.sendRawTransaction.mock.calls[0]?.[0]).toMatchObject({
      txID: id.slice(2).toUpperCase(),
    })
  })

  it.each([
    [
      'result false with a code',
      { result: false, code: 'SIGERROR', message: hex('Validate signature error') },
      'SIGERROR',
      'Validate signature error',
    ],
    [
      'a code without result',
      { code: 'BANDWITH_ERROR', txid: 'aa', message: hex('Account resource insufficient error.') },
      'BANDWITH_ERROR',
      'Account resource insufficient error.',
    ],
    ['result false alone', { result: false }, undefined, 'no message'],
    [
      'a plain-text message',
      { code: 'TAPOS_ERROR', message: 'Tapos check error.' },
      'TAPOS_ERROR',
      'Tapos check error.',
    ],
    ['a numeric code', { code: 3 }, undefined, 'no message'],
  ])('a refusal with %s is BroadcastError', async (_, answer, nodeCode, text) => {
    const tronWeb = fakeTronWeb()
    tronWeb.trx.sendRawTransaction.mockResolvedValueOnce(answer)
    const error = await failure(send(tronWeb, { to: CONTRACT, data: DATA }))
    expect(error).toBeInstanceOf(BroadcastError)
    expect((error as BroadcastError).nodeCode).toBe(nodeCode)
    expect((error as BroadcastError).shortMessage).toContain(text)
    expect((error as BroadcastError).cause).toBe(answer)
    expect(callCounts(tronWeb)).toEqual(SENT)
  })

  it.each(thrownForms('timeout of 30000ms exceeded'))(
    'a broadcast that throws %s is BroadcastIndeterminateError',
    async (_, thrown) => {
      const tronWeb = fakeTronWeb()
      tronWeb.trx.sendRawTransaction.mockImplementationOnce(rejection(thrown))
      const error = (await failure(
        send(tronWeb, { to: CONTRACT, data: DATA }),
      )) as BroadcastIndeterminateError
      const id = `0x${await txIdOf(tronWeb)}`
      expect(error).toBeInstanceOf(BroadcastIndeterminateError)
      expect(error.transactionId).toBe(id)
      expect(error.data).toEqual({ transactionId: id })
      expect(error.message).toContain(id)
      expect(error.cause).toBe(thrown)
      expect(callCounts(tronWeb)).toEqual(SENT)
    },
  )

  it.each([
    [undefined],
    [null],
    ['ok'],
    [{}],
    [{ result: 'true' }],
    [{ txid: 'aa' }],
    [[]],
    [{ code: null }],
  ])(
    'an answer that is neither acceptance nor refusal is BroadcastIndeterminateError: %o',
    async (answer) => {
      const tronWeb = fakeTronWeb()
      tronWeb.trx.sendRawTransaction.mockResolvedValueOnce(answer)
      const error = await failure(send(tronWeb, { to: CONTRACT, data: DATA }))
      expect(error).toBeInstanceOf(BroadcastIndeterminateError)
      expect((error as BroadcastIndeterminateError).cause).toBe(answer)
      expect(callCounts(tronWeb)).toEqual(SENT)
    },
  )

  it.each([
    [{ code: 'DUP_TRANSACTION_ERROR', message: hex('Dup transaction.') }],
    [{ result: false, code: 'DUP_TRANSACTION_ERROR', txid: 'aa' }],
  ])(
    'a node that already knows the transaction is BroadcastIndeterminateError: %o',
    async (answer) => {
      const tronWeb = fakeTronWeb()
      tronWeb.trx.sendRawTransaction.mockResolvedValueOnce(answer)
      const error = await failure(send(tronWeb, { to: CONTRACT, data: DATA }))
      expect(error).toBeInstanceOf(BroadcastIndeterminateError)
      expect((error as BroadcastIndeterminateError).transactionId).toBe(
        `0x${await txIdOf(tronWeb)}`,
      )
      expect((error as BroadcastIndeterminateError).cause).toBe(answer)
    },
  )

  it('result true is acceptance even when a code is present', async () => {
    const tronWeb = fakeTronWeb()
    tronWeb.trx.sendRawTransaction.mockResolvedValueOnce({ result: true, code: 'SUCCESS' })
    expect(await send(tronWeb, { to: CONTRACT, data: DATA })).toMatch(/^0x[0-9a-f]{64}$/)
  })
})

describe('address conversion failures', () => {
  it.each(thrownForms('conversion failed'))(
    '%s thrown by fromHex is InvalidParamsRpcError and nothing is built',
    async (_, thrown) => {
      const tronWeb = fakeTronWeb()
      tronWeb.address.fromHex.mockImplementation(() => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- wallets throw non-errors
        throw thrown
      })
      await expectInvalidParams({ to: CONTRACT, data: DATA }, tronWeb)
    },
  )
})
