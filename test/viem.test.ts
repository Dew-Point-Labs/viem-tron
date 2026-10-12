import {
  BaseError,
  type Chain,
  InvalidInputRpcError,
  InvalidParamsRpcError,
  MethodNotSupportedRpcError,
  RpcRequestError,
  TransactionExecutionError,
  type Transport,
  UrlRequiredError,
  UserRejectedRequestError,
  concat,
  createPublicClient,
  createWalletClient,
  hashTypedData,
  keccak256,
  recoverAddress,
  stringToHex,
} from 'viem'
import { tron } from 'viem/chains'
import { describe, expect, it } from 'vitest'
import {
  BroadcastError,
  BroadcastIndeterminateError,
  SigningError,
  SimulationUnavailableError,
  TransactionBuildError,
  TransactionRevertedError,
  tronWebTransport,
} from '../src/index.js'
import {
  CONTRACT,
  CONTRACT_BASE58,
  type FakeTronWeb,
  OTHER,
  TRON_MESSAGE_HEADER,
  WALLET,
  WALLET_BASE58,
  callCounts,
  failure,
  fakeTronWeb,
  rejection,
  stubRead,
} from './fakes.js'

const hex = (text: string) => stringToHex(text).slice(2)
const call = { to: CONTRACT, data: '0xa9059cbb' } as const
const typedData = {
  types: { Note: [{ name: 'text', type: 'string' }] },
  domain: { chainId: tron.id, verifyingContract: CONTRACT },
  primaryType: 'Note',
  message: { text: 'hello' },
} as const

/**
 * Real viem clients over the transport, with viem's default retry settings: nothing here
 * passes `retryCount`.
 */
function setup(account: `0x${string}` = WALLET) {
  const tronWeb = fakeTronWeb()
  const read = stubRead(() => ({ result: '0x1' }))
  const transport = tronWebTransport(tronWeb, { rpc: read.transport })
  const wallet = createWalletClient({ account, chain: tron, transport })
  return { tronWeb, read, wallet, raw: transport({ chain: tron }) }
}

type Surface = (context: ReturnType<typeof setup>) => Promise<unknown>
const requestSend: Surface = ({ raw }) =>
  raw.request({ method: 'eth_sendTransaction', params: [{ from: WALLET, ...call }] })
const requestSign: Surface = ({ raw }) =>
  raw.request({ method: 'eth_signTypedData_v4', params: [WALLET, JSON.stringify(typedData)] })
const clientSign: Surface = ({ wallet }) => wallet.signTypedData(typedData)
const clientSend: Surface = ({ wallet }) => wallet.sendTransaction(call)

/** The error viem's sendTransaction wraps, found the way a caller finds it. */
function walked<T extends Error>(error: unknown, type: new (...args: never[]) => T): T {
  expect(error).toBeInstanceOf(TransactionExecutionError)
  const found = (error as BaseError).walk((e) => e instanceof type)
  expect(found).toBeInstanceOf(type)
  // A failed send must not be reported as an unsupported wallet_sendTransaction.
  expect((error as BaseError).walk((e) => e instanceof MethodNotSupportedRpcError)).toBeNull()
  expect((error as BaseError).message).not.toContain('wallet_sendTransaction')
  return found as T
}

describe('happy paths through viem clients', () => {
  it('sendTransaction builds, simulates, signs and broadcasts once and returns the id', async () => {
    const context = setup()
    const id = await context.wallet.sendTransaction({ ...call, value: 1_500_000n })
    expect(id).toMatch(/^0x[0-9a-f]{64}$/)
    expect(callCounts(context.tronWeb)).toEqual({
      build: 1,
      simulate: 1,
      transfer: 0,
      sign: 1,
      broadcast: 1,
    })
    expect(context.tronWeb.transactionBuilder.triggerSmartContract).toHaveBeenCalledWith(
      CONTRACT_BASE58,
      '',
      { feeLimit: 300_000_000, input: 'a9059cbb', callValue: 1_500_000 },
      [],
      WALLET_BASE58,
    )
  })

  it('signTypedData signs the EIP-712 digest as a Tron signed message', async () => {
    const context = setup()
    // viem serialises a bigint chainId to a decimal string before it reaches the transport.
    const input = { ...typedData, domain: { ...typedData.domain, chainId: BigInt(tron.id) } }
    const signature = await context.wallet.signTypedData(input)
    const digest = hashTypedData(input)
    expect(context.tronWeb.trx.sign).toHaveBeenCalledExactlyOnceWith(digest.slice(2))
    const prefixed = keccak256(concat([stringToHex(TRON_MESSAGE_HEADER), digest]))
    expect((await recoverAddress({ hash: prefixed, signature })).toLowerCase()).toBe(WALLET)
  })

  it('getAddresses and getChainId are answered locally', async () => {
    const context = setup()
    expect((await context.wallet.getAddresses()).map((a) => a.toLowerCase())).toEqual([WALLET])
    expect(await context.wallet.getChainId()).toBe(tron.id)
    expect(context.read.request).not.toHaveBeenCalled()
  })
})

describe('4.6 viem-native errors', () => {
  describe('user refused to sign → UserRejectedRequestError (4001)', () => {
    const refuse = (tronWeb: FakeTronWeb) => {
      const thrown = 'Confirmation declined by user'
      tronWeb.trx.sign.mockImplementation(rejection(thrown))
      return thrown
    }

    it.each([
      ['transport.request(eth_sendTransaction)', requestSend],
      ['transport.request(eth_signTypedData_v4)', requestSign],
      ['walletClient.signTypedData', clientSign],
    ])('%s: a new instance of the class with ours as cause', async (_, surface) => {
      const context = setup()
      const thrown = refuse(context.tronWeb)
      const error = (await failure(surface(context))) as UserRejectedRequestError
      expect(error).toBeInstanceOf(UserRejectedRequestError)
      expect(error.code).toBe(4001)
      const ours = error.cause as UserRejectedRequestError
      expect(ours).toBeInstanceOf(UserRejectedRequestError)
      expect(ours.code).toBe(4001)
      expect((ours.cause as Error).cause).toBe(thrown)
      expect(context.tronWeb.trx.sign).toHaveBeenCalledTimes(1)
      expect(callCounts(context.tronWeb).broadcast).toBe(0)
    })

    it('walletClient.sendTransaction: found via error.walk', async () => {
      const context = setup()
      refuse(context.tronWeb)
      const found = walked(await failure(clientSend(context)), UserRejectedRequestError)
      expect(found.code).toBe(4001)
      expect(context.tronWeb.trx.sign).toHaveBeenCalledTimes(1)
      expect(callCounts(context.tronWeb).broadcast).toBe(0)
    })
  })

  describe('malformed params, wrong sender, contract creation → InvalidParamsRpcError (-32602)', () => {
    it.each([
      ['malformed params', { from: WALLET, to: CONTRACT, data: '0xabc' }],
      ['wrong sender', { from: OTHER, ...call }],
      ['contract creation', { from: WALLET, data: '0x6080' }],
    ])('transport.request, %s: a new instance of the class with ours as cause', async (_, tx) => {
      const context = setup()
      const error = (await failure(
        context.raw.request({ method: 'eth_sendTransaction', params: [tx] }),
      )) as InvalidParamsRpcError
      expect(error).toBeInstanceOf(InvalidParamsRpcError)
      expect(error.code).toBe(-32602)
      expect(error.cause).toBeInstanceOf(InvalidParamsRpcError)
      expect((error.cause as InvalidParamsRpcError).code).toBe(-32602)
      expect(callCounts(context.tronWeb)).toEqual({
        build: 0,
        simulate: 0,
        transfer: 0,
        sign: 0,
        broadcast: 0,
      })
    })

    it('transport.request(eth_signTypedData_v4), wrong sender', async () => {
      const context = setup()
      const error = (await failure(
        context.raw.request({ method: 'eth_signTypedData_v4', params: [OTHER, typedData] }),
      )) as InvalidParamsRpcError
      expect(error).toBeInstanceOf(InvalidParamsRpcError)
      expect(error.code).toBe(-32602)
      expect(error.cause).toBeInstanceOf(InvalidParamsRpcError)
      expect(context.tronWeb.trx.sign).not.toHaveBeenCalled()
    })

    it('walletClient.signTypedData, wrong sender', async () => {
      const context = setup(OTHER)
      const error = (await failure(clientSign(context))) as InvalidParamsRpcError
      expect(error).toBeInstanceOf(InvalidParamsRpcError)
      expect(error.code).toBe(-32602)
      expect(error.cause).toBeInstanceOf(InvalidParamsRpcError)
      expect(context.tronWeb.trx.sign).not.toHaveBeenCalled()
    })

    it('walletClient.sendTransaction, wrong sender: found via error.walk, not masked by wallet_sendTransaction', async () => {
      const context = setup(OTHER)
      const found = walked(await failure(clientSend(context)), InvalidParamsRpcError)
      expect(found.code).toBe(-32602)
      expect(found.details).toContain('`from`')
      expect(callCounts(context.tronWeb)).toEqual({
        build: 0,
        simulate: 0,
        transfer: 0,
        sign: 0,
        broadcast: 0,
      })
    })

    it('walletClient.sendTransaction, contract creation: found via error.walk', async () => {
      const context = setup()
      const error = await failure(context.wallet.sendTransaction({ data: '0x6080' }))
      expect(walked(error, InvalidParamsRpcError).details).toMatch(/contract creation/)
    })
  })

  describe('method outside the supported set → MethodNotSupportedRpcError (-32004)', () => {
    it('transport.request: a new instance of the class with ours as cause', async () => {
      const context = setup()
      const error = (await failure(
        context.raw.request({ method: 'personal_sign', params: ['0x00', WALLET] }),
      )) as MethodNotSupportedRpcError
      expect(error).toBeInstanceOf(MethodNotSupportedRpcError)
      expect(error.code).toBe(-32004)
      expect(error.cause).toBeInstanceOf(MethodNotSupportedRpcError)
      expect((error.cause as MethodNotSupportedRpcError).code).toBe(-32004)
    })

    it('walletClient.signMessage', async () => {
      const context = setup()
      const error = await failure(context.wallet.signMessage({ message: 'hi' }))
      expect(error).toBeInstanceOf(MethodNotSupportedRpcError)
      expect(context.tronWeb.trx.sign).not.toHaveBeenCalled()
    })
  })

  it('no read endpoint → UrlRequiredError when the client is constructed', () => {
    const chain = { ...tron, rpcUrls: { default: { http: [] } } } as Chain
    expect(() => createWalletClient({ chain, transport: tronWebTransport(fakeTronWeb()) })).toThrow(
      UrlRequiredError,
    )
  })
})

describe('4.6 errors of this package', () => {
  const revertAnswer = {
    result: { result: true, message: hex('REVERT opcode executed') },
    constant_result: ['08c379a0'],
    transaction: { ret: [{ ret: 'FAILED' }] },
  }
  const cases = [
    {
      name: 'TransactionRevertedError (thrown revert)',
      type: TransactionRevertedError,
      fail: (t: FakeTronWeb) => t.transactionBuilder.triggerConstantContract,
      thrown: new Error('REVERT opcode executed'),
      fields: { reason: undefined, data: undefined },
      counts: { build: 1, simulate: 1, transfer: 0, sign: 0, broadcast: 0 },
    },
    {
      name: 'TransactionRevertedError (returned revert bytes)',
      type: TransactionRevertedError,
      fail: (t: FakeTronWeb) => t.transactionBuilder.triggerConstantContract,
      returned: revertAnswer,
      fields: { reason: undefined, data: '0x08c379a0' },
      counts: { build: 1, simulate: 1, transfer: 0, sign: 0, broadcast: 0 },
    },
    {
      name: 'TransactionRevertedError (out of energy)',
      type: TransactionRevertedError,
      fail: (t: FakeTronWeb) => t.transactionBuilder.triggerConstantContract,
      thrown: 'OUT_OF_ENERGY',
      fields: { reason: 'OUT_OF_ENERGY', data: undefined },
      counts: { build: 1, simulate: 1, transfer: 0, sign: 0, broadcast: 0 },
    },
    {
      name: 'SimulationUnavailableError',
      type: SimulationUnavailableError,
      fail: (t: FakeTronWeb) => t.transactionBuilder.triggerConstantContract,
      thrown: { status: 429, message: 'Request failed with status code 429' },
      fields: {},
      counts: { build: 1, simulate: 1, transfer: 0, sign: 0, broadcast: 0 },
    },
    {
      name: 'TransactionBuildError',
      type: TransactionBuildError,
      fail: (t: FakeTronWeb) => t.transactionBuilder.triggerSmartContract,
      thrown: new Error('No contract or not a valid smart contract'),
      fields: {},
      counts: { build: 1, simulate: 0, transfer: 0, sign: 0, broadcast: 0 },
    },
    {
      name: 'SigningError',
      type: SigningError,
      fail: (t: FakeTronWeb) => t.trx.sign,
      thrown: new Error('Private key does not match address in transaction'),
      fields: {},
      counts: { build: 1, simulate: 1, transfer: 0, sign: 1, broadcast: 0 },
    },
    {
      name: 'BroadcastError',
      type: BroadcastError,
      fail: (t: FakeTronWeb) => t.trx.sendRawTransaction,
      returned: { code: 'SIGERROR', message: hex('Validate signature error') },
      fields: { nodeCode: 'SIGERROR' },
      counts: { build: 1, simulate: 1, transfer: 0, sign: 1, broadcast: 1 },
    },
    {
      name: 'BroadcastIndeterminateError',
      type: BroadcastIndeterminateError,
      fail: (t: FakeTronWeb) => t.trx.sendRawTransaction,
      thrown: new Error('timeout of 30000ms exceeded'),
      fields: {},
      counts: { build: 1, simulate: 1, transfer: 0, sign: 1, broadcast: 1 },
    },
  ]

  function arrange(context: ReturnType<typeof setup>, testCase: (typeof cases)[number]) {
    const method = testCase.fail(context.tronWeb)
    // Every call fails, so a retry by viem would show up in the call counts.
    if ('thrown' in testCase) method.mockImplementation(rejection(testCase.thrown))
    else method.mockResolvedValue(testCase.returned)
    return 'thrown' in testCase ? testCase.thrown : testCase.returned
  }

  describe.each(cases)('$name', (testCase) => {
    it('transport.request: the same instance — the class itself, no code, original as cause', async () => {
      const context = setup()
      const original = arrange(context, testCase)
      const error = (await failure(requestSend(context))) as BaseError
      expect(error.constructor).toBe(testCase.type)
      expect('code' in error).toBe(false)
      expect(error.cause).toBe(original)
      expect(error).toMatchObject(testCase.fields)
      expect(callCounts(context.tronWeb)).toEqual(testCase.counts)
    })

    it('walletClient.sendTransaction: found via error.walk, reached TronWeb once', async () => {
      const context = setup()
      const original = arrange(context, testCase)
      const found = walked(await failure(clientSend(context)), testCase.type)
      expect('code' in found).toBe(false)
      expect(found.cause).toBe(original)
      expect(found).toMatchObject(testCase.fields)
      expect(callCounts(context.tronWeb)).toEqual(testCase.counts)
    })
  })

  it('SigningError from walletClient.signTypedData and transport.request is the same instance', async () => {
    for (const surface of [clientSign, requestSign]) {
      const context = setup()
      const thrown = new Error('Expected hex message input')
      context.tronWeb.trx.sign.mockImplementation(rejection(thrown))
      const error = (await failure(surface(context))) as SigningError
      expect(error.constructor).toBe(SigningError)
      expect('code' in error).toBe(false)
      expect(error.cause).toBe(thrown)
      expect(context.tronWeb.trx.sign).toHaveBeenCalledTimes(1)
    }
  })

  it('BroadcastIndeterminateError exposes transactionId, data.transactionId and the id in its message', async () => {
    for (const surface of [requestSend, clientSend]) {
      const context = setup()
      context.tronWeb.trx.sendRawTransaction.mockImplementation(
        rejection(new Error('socket hang up')),
      )
      const thrown = await failure(surface(context))
      const error = (thrown as BaseError).walk(
        (e) => e instanceof BroadcastIndeterminateError,
      ) as BroadcastIndeterminateError
      const signed = (await context.tronWeb.trx.sign.mock.results[0]?.value) as { txID: string }
      const id = `0x${signed.txID}`
      expect(error.transactionId).toBe(id)
      expect(error.data).toEqual({ transactionId: id })
      expect(error.message).toContain(id)
      expect((thrown as Error).message).toContain(id)
      expect(context.tronWeb.trx.sendRawTransaction).toHaveBeenCalledTimes(1)
    }
  })
})

describe('no request handled through TronWeb is re-issued', () => {
  // Shapes viem would retry if they reached it unconverted.
  const retriable = [
    ['an error without a code', new Error('network error')],
    ['code -32603', { code: -32603, message: 'Internal error' }],
    ['code -32005', { code: -32005, message: 'limit exceeded' }],
    ['code -1', { code: -1, message: 'unknown' }],
    ['an HTTP 429', { status: 429, message: 'Too Many Requests' }],
    ['a string', 'ECONNRESET'],
  ] as const
  const steps = [
    ['build', (t: FakeTronWeb) => t.transactionBuilder.triggerSmartContract],
    ['simulate', (t: FakeTronWeb) => t.transactionBuilder.triggerConstantContract],
    ['sign', (t: FakeTronWeb) => t.trx.sign],
    ['broadcast', (t: FakeTronWeb) => t.trx.sendRawTransaction],
  ] as const

  describe.each(retriable)('when TronWeb throws %s', (_, thrown) => {
    it.each(steps)('a send failing at %s reaches TronWeb exactly once', async (step, pick) => {
      for (const surface of [requestSend, clientSend]) {
        const context = setup()
        pick(context.tronWeb).mockImplementation(rejection(thrown))
        const error = (await failure(surface(context))) as BaseError
        expect(error.walk((e) => e === thrown)).toBe(thrown)
        expect(callCounts(context.tronWeb)[step]).toBe(1)
      }
    })

    it('a failing signature reaches TronWeb exactly once', async () => {
      for (const surface of [requestSign, clientSign]) {
        const context = setup()
        context.tronWeb.trx.sign.mockImplementation(rejection(thrown))
        expect(await failure(surface(context))).toBeInstanceOf(SigningError)
        expect(context.tronWeb.trx.sign).toHaveBeenCalledTimes(1)
      }
    })
  })

  it('a failing TRX transfer build reaches TronWeb exactly once', async () => {
    const context = setup()
    context.tronWeb.transactionBuilder.sendTrx.mockImplementation(
      rejection(new Error('network error')),
    )
    const error = await failure(context.wallet.sendTransaction({ to: CONTRACT, value: 1n }))
    walked(error, TransactionBuildError)
    expect(callCounts(context.tronWeb)).toEqual({
      build: 0,
      simulate: 0,
      transfer: 1,
      sign: 0,
      broadcast: 0,
    })
  })
})

describe('a reverted forwarded eth_call', () => {
  const node = { code: -32000, message: 'REVERT opcode executed', data: '0x08c379a0' }
  const reverting = () => {
    const tronWeb = fakeTronWeb()
    const read = stubRead(() => ({ error: node }))
    const transport: Transport = tronWebTransport(tronWeb, { rpc: read.transport })
    return { tronWeb, read, transport }
  }

  it("transport.request: InvalidInputRpcError wrapping the read transport's error, node error at the leaf", async () => {
    const { transport, read, tronWeb } = reverting()
    const error = (await failure(
      transport({ chain: tron }).request({ method: 'eth_call', params: [call, 'latest'] }),
    )) as InvalidInputRpcError
    expect(error).toBeInstanceOf(InvalidInputRpcError)
    expect(error.code).toBe(-32000)
    // The read transport's own error, itself wrapping the request error.
    expect(error.cause).toBeInstanceOf(InvalidInputRpcError)
    expect((error.cause as InvalidInputRpcError).cause).toBeInstanceOf(RpcRequestError)
    expect(error.walk()).toEqual(node)
    expect(error.details).toBe('REVERT opcode executed')
    expect(read.request).toHaveBeenCalledTimes(1)
    expect(callCounts(tronWeb)).toEqual({
      build: 0,
      simulate: 0,
      transfer: 0,
      sign: 0,
      broadcast: 0,
    })
  })

  it("publicClient.call: the same chain below viem's CallExecutionError", async () => {
    const { transport } = reverting()
    const client = createPublicClient({ chain: tron, transport })
    const error = (await failure(client.call({ ...call, account: WALLET }))) as BaseError
    expect(error.name).toBe('CallExecutionError')
    expect(error.walk((e) => e instanceof InvalidInputRpcError)).toBeInstanceOf(
      InvalidInputRpcError,
    )
    expect(error.walk()).toEqual(node)
  })
})
