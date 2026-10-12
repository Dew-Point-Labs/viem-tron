import {
  type BaseError,
  type Chain,
  InvalidInputRpcError,
  InvalidParamsRpcError,
  MethodNotSupportedRpcError,
  RpcRequestError,
  TransactionExecutionError,
  TransactionRejectedRpcError,
  UrlRequiredError,
  UserRejectedRequestError,
  concat,
  createPublicClient,
  createWalletClient,
  fallback,
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
  TronWebTransportError,
  tronWebTransport,
} from '../src/index.js'
import {
  CONTRACT,
  CONTRACT_BASE58,
  type FakeTronWeb,
  NONE,
  OTHER,
  TRON_MESSAGE_HEADER,
  WALLET,
  WALLET_BASE58,
  callCounts,
  failure,
  fakeTronWeb,
  hex,
  rejection,
  stubRead,
} from './fakes.js'

const call = { to: CONTRACT, data: '0xa9059cbb' } as const
const typedData = {
  types: { Note: [{ name: 'text', type: 'string' }] },
  domain: { chainId: tron.id, verifyingContract: CONTRACT },
  primaryType: 'Note',
  message: { text: 'hello' },
} as const
const sendFrom = (from: string) => ({ method: 'eth_sendTransaction', params: [{ from, ...call }] })
const signAs = (address: string) => ({
  method: 'eth_signTypedData_v4',
  params: [address, JSON.stringify(typedData)],
})
const sendRequest = sendFrom(WALLET)
const signRequest = signAs(WALLET)
const readStub = () => stubRead(() => ({ result: '0x1' })).transport

/** Real viem clients over the transport with viem's default retry settings. */
function setup(account: `0x${string}` = WALLET) {
  const tronWeb = fakeTronWeb()
  const transport = tronWebTransport(tronWeb, { rpc: readStub() })
  const wallet = createWalletClient({ account, chain: tron, transport })
  return { tronWeb, wallet, account, raw: transport({ chain: tron }) }
}

type Context = ReturnType<typeof setup>
const surfaces = {
  'transport.request(eth_sendTransaction)': ({ raw, account }: Context) =>
    raw.request(sendFrom(account)),
  'transport.request(eth_signTypedData_v4)': ({ raw, account }: Context) =>
    raw.request(signAs(account)),
  'walletClient.signTypedData': ({ wallet }: Context) => wallet.signTypedData(typedData),
  'walletClient.sendTransaction': ({ wallet }: Context) => wallet.sendTransaction(call),
}
const signing = ['transport.request(eth_signTypedData_v4)', 'walletClient.signTypedData'] as const
const sending = ['transport.request(eth_sendTransaction)', 'walletClient.sendTransaction'] as const

/** The error of the given class in the chain, found the way a caller finds it. */
function walked<T extends Error>(error: unknown, type: new (...args: never[]) => T): T {
  const found = (error as BaseError).walk((e) => e instanceof type)
  expect(found).toBeInstanceOf(type)
  return found as T
}

/** A failed send must not be reported as an unsupported wallet_sendTransaction. */
function expectNotMasked(error: unknown) {
  expect(error).toBeInstanceOf(TransactionExecutionError)
  expect((error as BaseError).walk((e) => e instanceof MethodNotSupportedRpcError)).toBeNull()
  expect((error as BaseError).message).not.toContain('wallet_sendTransaction')
}

describe('happy paths through viem clients', () => {
  it('sendTransaction builds, simulates, signs and broadcasts once and returns the id', async () => {
    const { tronWeb, wallet } = setup()
    const id = await wallet.sendTransaction({ ...call, value: 1_500_000n })
    expect(id).toMatch(/^0x[0-9a-f]{64}$/)
    expect(callCounts(tronWeb)).toEqual({ ...NONE, build: 1, simulate: 1, sign: 1, broadcast: 1 })
    expect(tronWeb.transactionBuilder.triggerSmartContract).toHaveBeenCalledWith(
      CONTRACT_BASE58,
      '',
      { feeLimit: 300_000_000, input: 'a9059cbb', callValue: 1_500_000 },
      [],
      WALLET_BASE58,
    )
  })

  it('signTypedData signs the EIP-712 digest as a Tron signed message', async () => {
    const { tronWeb, wallet } = setup()
    const signature = await wallet.signTypedData(typedData)
    const digest = hashTypedData(typedData)
    expect(tronWeb.trx.sign).toHaveBeenCalledExactlyOnceWith(digest.slice(2))
    const prefixed = keccak256(concat([stringToHex(TRON_MESSAGE_HEADER), digest]))
    expect((await recoverAddress({ hash: prefixed, signature })).toLowerCase()).toBe(WALLET)
  })

  it('signTypedData with a bigint chainId signs what viem hashes for the same input', async () => {
    const { tronWeb, wallet } = setup()
    const input = { ...typedData, domain: { ...typedData.domain, chainId: BigInt(tron.id) } }
    await wallet.signTypedData(input)
    expect(tronWeb.trx.sign).toHaveBeenCalledExactlyOnceWith(hashTypedData(input).slice(2))
  })

  it('getAddresses and getChainId are answered locally', async () => {
    const { wallet } = setup()
    expect((await wallet.getAddresses()).map((a) => a.toLowerCase())).toEqual([WALLET])
    expect(await wallet.getChainId()).toBe(tron.id)
  })
})

describe('viem-native errors', () => {
  describe('user refused to sign → UserRejectedRequestError (4001)', () => {
    it.each(Object.entries(surfaces))('%s', async (name, surface) => {
      const context = setup()
      const thrown = 'Confirmation declined by user'
      context.tronWeb.trx.sign.mockImplementation(rejection(thrown))
      const error = await failure(surface(context))
      if (name === 'walletClient.sendTransaction') expectNotMasked(error)
      else expect(error).toBeInstanceOf(UserRejectedRequestError)
      const found = walked(error, UserRejectedRequestError)
      expect(found.code).toBe(4001)
      expect((error as BaseError).walk((e) => e === thrown)).toBe(thrown)
      expect(context.tronWeb.trx.sign).toHaveBeenCalledTimes(1)
      expect(callCounts(context.tronWeb).broadcast).toBe(0)
    })
  })

  describe('wrong sender → InvalidParamsRpcError (-32602)', () => {
    it.each(Object.entries(surfaces))('%s', async (name, surface) => {
      const context = setup(OTHER)
      const error = await failure(surface(context))
      if (name === 'walletClient.sendTransaction') expectNotMasked(error)
      else {
        // A new instance of viem's class, with the one this package threw as cause.
        expect(error).toBeInstanceOf(InvalidParamsRpcError)
        expect((error as InvalidParamsRpcError).cause).toBeInstanceOf(InvalidParamsRpcError)
      }
      expect(walked(error, InvalidParamsRpcError).code).toBe(-32602)
      expect(callCounts(context.tronWeb)).toEqual(NONE)
    })

    it('walletClient.sendTransaction without `to` reports contract creation, unmasked', async () => {
      const { wallet } = setup()
      const error = await failure(wallet.sendTransaction({ data: '0x6080' }))
      expectNotMasked(error)
      expect(walked(error, InvalidParamsRpcError).details).toMatch(/contract creation/)
    })
  })

  describe('method outside the supported set → MethodNotSupportedRpcError (-32004)', () => {
    it('transport.request: a new instance of the class with ours as cause', async () => {
      const { raw } = setup()
      const error = (await failure(
        raw.request({ method: 'personal_sign', params: ['0x00', WALLET] }),
      )) as MethodNotSupportedRpcError
      expect(error).toBeInstanceOf(MethodNotSupportedRpcError)
      expect(error.code).toBe(-32004)
      expect(error.cause).toBeInstanceOf(MethodNotSupportedRpcError)
    })

    it('walletClient.signMessage', async () => {
      const { tronWeb, wallet } = setup()
      expect(await failure(wallet.signMessage({ message: 'hi' }))).toBeInstanceOf(
        MethodNotSupportedRpcError,
      )
      expect(tronWeb.trx.sign).not.toHaveBeenCalled()
    })
  })

  it('no read endpoint → UrlRequiredError when the client is constructed', () => {
    const chain = { ...tron, rpcUrls: { default: { http: [] } } } as Chain
    expect(() => createWalletClient({ chain, transport: tronWebTransport(fakeTronWeb()) })).toThrow(
      UrlRequiredError,
    )
  })
})

describe('errors of this package', () => {
  const builder = (t: FakeTronWeb) => t.transactionBuilder
  const cases = [
    {
      type: TransactionRevertedError,
      fail: (t: FakeTronWeb) => builder(t).triggerConstantContract,
      thrown: new Error('REVERT opcode executed'),
      counts: { ...NONE, build: 1, simulate: 1 },
    },
    {
      type: SimulationUnavailableError,
      fail: (t: FakeTronWeb) => builder(t).triggerConstantContract,
      thrown: { status: 429, message: 'Request failed with status code 429' },
      counts: { ...NONE, build: 1, simulate: 1 },
    },
    {
      type: TransactionBuildError,
      fail: (t: FakeTronWeb) => builder(t).triggerSmartContract,
      thrown: new Error('No contract or not a valid smart contract'),
      counts: { ...NONE, build: 1 },
    },
    {
      type: SigningError,
      fail: (t: FakeTronWeb) => t.trx.sign,
      thrown: new Error('Private key does not match address in transaction'),
      counts: { ...NONE, build: 1, simulate: 1, sign: 1 },
    },
    {
      type: BroadcastError,
      fail: (t: FakeTronWeb) => t.trx.sendRawTransaction,
      returned: { code: 'SIGERROR', message: hex('Validate signature error') },
      fields: { nodeCode: 'SIGERROR' },
      counts: { ...NONE, build: 1, simulate: 1, sign: 1, broadcast: 1 },
    },
    {
      type: BroadcastIndeterminateError,
      fail: (t: FakeTronWeb) => t.trx.sendRawTransaction,
      thrown: new Error('timeout of 30000ms exceeded'),
      counts: { ...NONE, build: 1, simulate: 1, sign: 1, broadcast: 1 },
    },
  ].map((testCase) => ({ name: testCase.type.name, ...testCase }))

  describe.each(cases)('$name', (testCase) => {
    it.each(sending)('%s', async (name) => {
      const context = setup()
      const method = testCase.fail(context.tronWeb)
      // Every call fails, so a retry by viem would show up in the call counts.
      if ('thrown' in testCase) method.mockImplementation(rejection(testCase.thrown))
      else method.mockResolvedValue(testCase.returned)
      const error = await failure(surfaces[name](context))

      if (name === 'walletClient.sendTransaction') expectNotMasked(error)
      else {
        expect(error).toBeInstanceOf(TransactionRejectedRpcError)
        expect((error as TransactionRejectedRpcError).code).toBe(-32003)
        expect((error as TransactionRejectedRpcError).cause).toBeInstanceOf(testCase.type)
      }
      const ours = walked(error, TronWebTransportError)
      expect(ours.constructor).toBe(testCase.type)
      expect(ours.code).toBe(-32003)
      expect(ours.cause).toBe('thrown' in testCase ? testCase.thrown : testCase.returned)
      expect(ours).toMatchObject(testCase.fields ?? {})
      expect(callCounts(context.tronWeb)).toEqual(testCase.counts)
    })
  })

  it.each(signing)('SigningError from %s', async (name) => {
    const context = setup()
    const thrown = new Error('Expected hex message input')
    context.tronWeb.trx.sign.mockImplementation(rejection(thrown))
    const error = await failure(surfaces[name](context))
    expect(error).toBeInstanceOf(TransactionRejectedRpcError)
    expect(walked(error, SigningError).cause).toBe(thrown)
    expect(context.tronWeb.trx.sign).toHaveBeenCalledTimes(1)
  })

  it.each(sending)(
    'BroadcastIndeterminateError from %s exposes the id as a field, in data and in the message',
    async (name) => {
      const context = setup()
      context.tronWeb.trx.sendRawTransaction.mockImplementation(
        rejection(new Error('socket hang up')),
      )
      const thrown = await failure(surfaces[name](context))
      const error = walked(thrown, BroadcastIndeterminateError)
      const built = (await context.tronWeb.transactionBuilder.triggerSmartContract.mock.results[0]
        ?.value) as { transaction: { txID: string } }
      const id = `0x${built.transaction.txID}`
      expect(error.transactionId).toBe(id)
      expect(error.data).toEqual({ transactionId: id })
      expect(error.message).toContain(id)
      expect((thrown as Error).message).toContain(id)
      expect(error.code).toBe(-32003)
    },
  )
})

describe('a wallet action is never re-issued', () => {
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

  describe.each(retriable)('default retry settings, TronWeb throws %s', (_, thrown) => {
    describe.each(steps)('a send failing at %s', (step, pick) => {
      it.each(sending)('%s reaches TronWeb exactly once', async (name) => {
        const context = setup()
        pick(context.tronWeb).mockImplementation(rejection(thrown))
        const error = (await failure(surfaces[name](context))) as BaseError
        expect(error.walk((e) => e === thrown)).toBe(thrown)
        expect(callCounts(context.tronWeb)[step]).toBe(1)
      })
    })

    it.each(signing)(
      'a failing signature through %s reaches TronWeb exactly once',
      async (name) => {
        const context = setup()
        context.tronWeb.trx.sign.mockImplementation(rejection(thrown))
        walked(await failure(surfaces[name](context)), SigningError)
        expect(context.tronWeb.trx.sign).toHaveBeenCalledTimes(1)
      },
    )
  })

  describe('a per-request retryCount is overridden', () => {
    it('a failing read with a retriable error is sent once when the read transport does not retry', async () => {
      const read = stubRead(() => ({ error: { code: -32603, message: 'internal' } }))
      const transport = tronWebTransport(fakeTronWeb(), { rpc: read.transport })({ chain: tron })
      await failure(
        transport.request({ method: 'eth_blockNumber' }, { retryCount: 2, retryDelay: 0 }),
      )
      expect(read.request).toHaveBeenCalledTimes(1)
    })

    it('a send whose broadcast throws runs every step once', async () => {
      const { tronWeb, raw } = setup()
      tronWeb.trx.sendRawTransaction.mockImplementation(rejection(new Error('socket hang up')))
      await failure(raw.request(sendRequest, { retryCount: 2, retryDelay: 0 }))
      expect(callCounts(tronWeb)).toEqual({ ...NONE, build: 1, simulate: 1, sign: 1, broadcast: 1 })
    })

    it('a signature that throws is requested once', async () => {
      const { tronWeb, raw } = setup()
      tronWeb.trx.sign.mockImplementation(rejection(new Error('device disconnected')))
      await failure(raw.request(signRequest, { retryCount: 2, retryDelay: 0 }))
      expect(tronWeb.trx.sign).toHaveBeenCalledTimes(1)
    })
  })

  describe('fallback() does not pass a failed wallet action to its next transport', () => {
    const pair = () => {
      const [a, b] = [fakeTronWeb(), fakeTronWeb()]
      const transport = fallback(
        [tronWebTransport(a, { rpc: readStub() }), tronWebTransport(b, { rpc: readStub() })],
        { retryCount: 2, retryDelay: 0 },
      )
      const wallet = createWalletClient({ account: WALLET, chain: tron, transport })
      return { a, b, wallet, raw: transport({ chain: tron }) }
    }

    it.each(steps)('a send failing at %s reaches the first TronWeb once', async (step, pick) => {
      const { a, b, raw } = pair()
      pick(a).mockImplementation(rejection(new Error('network error')))
      walked(await failure(raw.request(sendRequest)), TronWebTransportError)
      expect(callCounts(a)[step]).toBe(1)
      expect(callCounts(b)).toEqual(NONE)
    })

    it('walletClient.sendTransaction: every step once on the first, nothing on the second', async () => {
      const { a, b, wallet } = pair()
      a.trx.sendRawTransaction.mockImplementation(rejection(new Error('socket hang up')))
      walked(await failure(wallet.sendTransaction(call)), BroadcastIndeterminateError)
      expect(callCounts(a)).toEqual({ ...NONE, build: 1, simulate: 1, sign: 1, broadcast: 1 })
      expect(callCounts(b)).toEqual(NONE)
    })

    it('a failing typed-data signature reaches the first TronWeb once', async () => {
      const { a, b, wallet } = pair()
      a.trx.sign.mockImplementation(rejection(new Error('device disconnected')))
      walked(await failure(wallet.signTypedData(typedData)), SigningError)
      expect(a.trx.sign).toHaveBeenCalledTimes(1)
      expect(b.trx.sign).not.toHaveBeenCalled()
    })

    it('a user refusal is not passed on', async () => {
      const { a, b, raw } = pair()
      a.trx.sign.mockImplementation(rejection('Confirmation declined by user'))
      walked(await failure(raw.request(sendRequest)), UserRejectedRequestError)
      expect(a.trx.sign).toHaveBeenCalledTimes(1)
      expect(callCounts(b)).toEqual(NONE)
    })
  })
})

describe('a reverted forwarded eth_call', () => {
  const node = { code: -32000, message: 'REVERT opcode executed', data: '0x08c379a0' }
  const reverting = () => {
    const tronWeb = fakeTronWeb()
    const read = stubRead(() => ({ error: node }))
    return { tronWeb, read, transport: tronWebTransport(tronWeb, { rpc: read.transport }) }
  }

  it("transport.request: InvalidInputRpcError wrapping the read transport's error, node error at the leaf", async () => {
    const { transport, read, tronWeb } = reverting()
    const error = (await failure(
      transport({ chain: tron }).request({ method: 'eth_call', params: [call, 'latest'] }),
    )) as InvalidInputRpcError
    expect(error).toBeInstanceOf(InvalidInputRpcError)
    expect(error.code).toBe(-32000)
    expect(error.cause).toBeInstanceOf(InvalidInputRpcError)
    expect((error.cause as InvalidInputRpcError).cause).toBeInstanceOf(RpcRequestError)
    expect(error.walk()).toEqual(node)
    expect(error.details).toBe('REVERT opcode executed')
    expect(read.request).toHaveBeenCalledTimes(1)
    expect(callCounts(tronWeb)).toEqual(NONE)
  })

  it("publicClient.call: the same chain below viem's CallExecutionError", async () => {
    const { transport } = reverting()
    const client = createPublicClient({ chain: tron, transport })
    const error = (await failure(client.call({ ...call, account: WALLET }))) as BaseError
    expect(error.name).toBe('CallExecutionError')
    walked(error, InvalidInputRpcError)
    expect(error.walk()).toEqual(node)
  })
})
