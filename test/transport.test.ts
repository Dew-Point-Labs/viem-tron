import {
  BaseError,
  type Chain,
  InternalRpcError,
  MethodNotSupportedRpcError,
  UrlRequiredError,
} from 'viem'
import { tron } from 'viem/chains'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tronWebTransport } from '../src/transport.js'
import {
  CONTRACT,
  CONTRACT_BASE58,
  WALLET,
  WALLET_BASE58,
  callCounts,
  failure,
  fakeTronWeb,
  stubRead,
} from './fakes.js'

const NONE = { build: 0, simulate: 0, transfer: 0, sign: 0, broadcast: 0 }
const ok = () => ({ result: '0x1' })

/** A `fetch` that answers every request with the given HTTP status and JSON body. */
function stubFetch(status: number, body: unknown = { jsonrpc: '2.0', id: 1, result: '0x10' }) {
  const fetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  )
  vi.stubGlobal('fetch', fetch)
  return fetch
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('construction', () => {
  it('creates a viem transport that never retries, exposing the TronWeb instance', () => {
    const tronWeb = fakeTronWeb()
    const transport = tronWebTransport(tronWeb, { rpc: stubRead(ok).transport })({ chain: tron })
    expect(transport.config).toMatchObject({
      key: 'tronWeb',
      name: 'TronWeb',
      type: 'tronWeb',
      retryCount: 0,
    })
    expect(transport.value?.tronWeb).toBe(tronWeb)
  })

  it('throws BaseError when no chain is given', () => {
    const transport = tronWebTransport(fakeTronWeb(), { rpc: 'http://read.invalid' })
    for (const args of [{}, { chain: undefined }]) {
      const error = (() => {
        try {
          return transport(args)
        } catch (e) {
          return e
        }
      })()
      expect(error).toBeInstanceOf(BaseError)
      expect(error).not.toBeInstanceOf(UrlRequiredError)
      expect((error as BaseError).shortMessage).toMatch(/chain/)
    }
  })

  it.each([
    ['a chain given as { id } only', { id: 1 }],
    ['a chain without default RPC URLs', { ...tron, rpcUrls: {} }],
    ['a chain with an empty URL list', { ...tron, rpcUrls: { default: { http: [] } } }],
  ])('throws UrlRequiredError for %s when `rpc` is not set', (_, chain) => {
    for (const config of [undefined, {}, { rpc: undefined }, { rpc: '' }])
      expect(() => tronWebTransport(fakeTronWeb(), config)({ chain: chain as Chain })).toThrow(
        UrlRequiredError,
      )
  })

  it('accepts a chain given as { id } only when `rpc` is set', async () => {
    const chain = { id: 5 } as Chain
    for (const rpc of ['http://read.invalid', stubRead(ok).transport]) {
      const transport = tronWebTransport(fakeTronWeb(), { rpc })({ chain })
      expect(await transport.request({ method: 'eth_chainId' })).toBe('0x5')
    }
  })

  it.each([[0], [-1], [1.5], [2 ** 53], [NaN], ['1000']])(
    'rejects feeLimit %o with BaseError',
    (feeLimit) => {
      // @ts-expect-error -- invalid input on purpose
      expect(() => tronWebTransport(fakeTronWeb(), { feeLimit })).toThrow(BaseError)
    },
  )

  it('uses a fee limit of 300_000_000 SUN by default, or the configured one', async () => {
    for (const [feeLimit, expected] of [
      [undefined, 300_000_000],
      [5_000_000, 5_000_000],
    ] as const) {
      const tronWeb = fakeTronWeb()
      const transport = tronWebTransport(tronWeb, { rpc: stubRead(ok).transport, feeLimit })({
        chain: tron,
      })
      await transport.request({
        method: 'eth_sendTransaction',
        params: [{ to: CONTRACT, data: '0x00' }],
      })
      expect(tronWeb.transactionBuilder.triggerSmartContract.mock.calls[0]?.[2].feeLimit).toBe(
        expected,
      )
    }
  })
})

describe('read transport from a URL', () => {
  const request = { method: 'eth_blockNumber' } as const

  it('sends reads to the given URL', async () => {
    const fetch = stubFetch(200)
    const transport = tronWebTransport(fakeTronWeb(), { rpc: 'http://read.invalid/jsonrpc' })({
      chain: tron,
    })
    expect(await transport.request(request)).toBe('0x10')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[0]).toBe('http://read.invalid/jsonrpc')
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toMatchObject(request)
  })

  it("defaults to the chain's first default RPC URL", async () => {
    const fetch = stubFetch(200)
    await tronWebTransport(fakeTronWeb())({ chain: tron }).request(request)
    expect(fetch.mock.calls[0]?.[0]).toBe(tron.rpcUrls.default.http[0])
  })
})

describe('read transport given as a Transport', () => {
  it('is instantiated once, with the chain only', async () => {
    const stub = stubRead(ok)
    const factory = vi.fn(stub.transport)
    const transport = tronWebTransport(fakeTronWeb(), { rpc: factory })({
      chain: tron,
      retryCount: 7,
      timeout: 1,
      pollingInterval: 9,
    })
    await transport.request({ method: 'eth_blockNumber' })
    await transport.request({ method: 'eth_gasPrice' })
    expect(factory).toHaveBeenCalledExactlyOnceWith({ chain: tron })
  })

  it('keeps its own retry settings', async () => {
    const stub = stubRead(() => ({ error: { code: -32603, message: 'internal' } }), 2)
    const transport = tronWebTransport(fakeTronWeb(), { rpc: stub.transport })({
      chain: tron,
    })
    expect(await failure(transport.request({ method: 'eth_blockNumber' }))).toBeInstanceOf(
      InternalRpcError,
    )
    expect(stub.request).toHaveBeenCalledTimes(3)
  })
})

describe('1. local methods', () => {
  const setup = () => {
    const tronWeb = fakeTronWeb()
    const read = stubRead(ok)
    const transport = tronWebTransport(tronWeb, { rpc: read.transport })({ chain: tron })
    return { tronWeb, read, transport }
  }

  it('eth_chainId is the hex of chain.id', async () => {
    const { transport, read, tronWeb } = setup()
    expect(await transport.request({ method: 'eth_chainId' })).toBe('0x2b6653dc')
    expect(read.request).not.toHaveBeenCalled()
    expect(callCounts(tronWeb)).toEqual(NONE)
  })

  it('net_version is the decimal string of chain.id', async () => {
    const { transport, read } = setup()
    expect(await transport.request({ method: 'net_version' })).toBe('728126428')
    expect(read.request).not.toHaveBeenCalled()
  })

  it('eth_accounts is the wallet address as 0x, or empty', async () => {
    const { transport, tronWeb, read } = setup()
    expect(await transport.request({ method: 'eth_accounts' })).toEqual([WALLET])
    tronWeb.defaultAddress = { hex: false, base58: false }
    expect(await transport.request({ method: 'eth_accounts' })).toEqual([])
    expect(read.request).not.toHaveBeenCalled()
  })

  it('eth_sendTransaction goes to TronWeb', async () => {
    const { transport, tronWeb, read } = setup()
    const id = await transport.request({
      method: 'eth_sendTransaction',
      params: [{ from: WALLET, to: CONTRACT, data: '0xa9059cbb' }],
    })
    expect(id).toMatch(/^0x[0-9a-f]{64}$/)
    expect(callCounts(tronWeb)).toEqual({ ...NONE, build: 1, simulate: 1, sign: 1, broadcast: 1 })
    expect(read.request).not.toHaveBeenCalled()
  })

  it.each(['eth_signTypedData_v4', 'eth_signTypedData'])('%s goes to TronWeb', async (method) => {
    const { transport, tronWeb, read } = setup()
    const typedData = {
      types: { Note: [{ name: 'text', type: 'string' }] },
      domain: { chainId: tron.id },
      primaryType: 'Note',
      message: { text: 'hello' },
    }
    const signature = await transport.request({ method, params: [WALLET, typedData] })
    expect(signature).toMatch(/^0x[0-9a-f]{128}1[bc]$/)
    expect(callCounts(tronWeb)).toEqual({ ...NONE, sign: 1 })
    expect(read.request).not.toHaveBeenCalled()
  })
})

describe('2. forwarded reads', () => {
  const methods = [
    ['eth_blockNumber', undefined],
    ['eth_getBlockByNumber', ['latest', false]],
    ['eth_getBlockByHash', ['0xaa', false]],
    ['eth_getBalance', [WALLET, 'latest']],
    ['eth_getCode', [CONTRACT, 'latest']],
    ['eth_getStorageAt', [CONTRACT, '0x0', 'latest']],
    ['eth_getLogs', [{ address: CONTRACT }]],
    ['eth_gasPrice', []],
    ['eth_getTransactionByHash', ['0xaa']],
    ['eth_getTransactionReceipt', ['0xaa']],
  ] as const

  it.each(methods)('%s is sent through the read transport untouched', async (method, params) => {
    const tronWeb = fakeTronWeb()
    const result = { blockHash: '0xbb', blockNumber: '0x1', status: '0x1' }
    const read = stubRead(() => ({ result }))
    const transport = tronWebTransport(tronWeb, { rpc: read.transport })({ chain: tron })
    expect(await transport.request({ method, params })).toEqual(result)
    expect(read.request).toHaveBeenCalledTimes(1)
    expect(read.request.mock.calls[0]?.[0].method).toBe(method)
    expect(read.request.mock.calls[0]?.[0].params).toBe(params)
    expect(callCounts(tronWeb)).toEqual(NONE)
  })

  it.each(['eth_call', 'eth_estimateGas'])(
    '%s is forwarded with addresses in 0x form and the wallet as `from`',
    async (method) => {
      const read = stubRead(() => ({ result: '0x' }))
      const transport = tronWebTransport(fakeTronWeb(), { rpc: read.transport })({ chain: tron })
      await transport.request({ method, params: [{ to: CONTRACT_BASE58, data: '0x00' }, 'latest'] })
      expect(read.request.mock.calls[0]?.[0]).toEqual({
        method,
        params: [{ to: CONTRACT, data: '0x00', from: WALLET }, 'latest'],
      })
      await transport.request({ method, params: [{ to: CONTRACT, from: WALLET_BASE58 }] })
      expect(read.request.mock.calls[1]?.[0].params).toEqual([{ to: CONTRACT, from: WALLET }])
    },
  )

  it.each(['eth_call', 'eth_estimateGas'])(
    '%s with a malformed address is refused without reaching the endpoint',
    async (method) => {
      const read = stubRead(ok)
      const transport = tronWebTransport(fakeTronWeb(), { rpc: read.transport })({ chain: tron })
      const error = await failure(transport.request({ method, params: [{ to: '0x1234' }] }))
      expect((error as { code: number }).code).toBe(-32602)
      expect(read.request).not.toHaveBeenCalled()
    },
  )

  it('eth_getTransactionByHash: a pending transaction gets standard null fields', async () => {
    const pending = {
      hash: '0xaa',
      blockHash: '0x',
      blockNumber: '0x',
      transactionIndex: '0x',
      gasPrice: '0x',
    }
    const read = stubRead(() => ({ result: pending }))
    const transport = tronWebTransport(fakeTronWeb(), { rpc: read.transport })({ chain: tron })
    expect(
      await transport.request({ method: 'eth_getTransactionByHash', params: ['0xaa'] }),
    ).toEqual({
      hash: '0xaa',
      blockHash: null,
      blockNumber: null,
      transactionIndex: null,
      gasPrice: '0x0',
    })
  })

  it('eth_getTransactionReceipt: a receipt that is not final is null', async () => {
    const read = stubRead(() => ({ result: { blockHash: '0x', blockNumber: '0x', status: '0x' } }))
    const transport = tronWebTransport(fakeTronWeb(), { rpc: read.transport })({ chain: tron })
    expect(
      await transport.request({ method: 'eth_getTransactionReceipt', params: ['0xaa'] }),
    ).toBeNull()
  })

  it('an unknown transaction hash stays null', async () => {
    const read = stubRead(() => ({ result: null }))
    const transport = tronWebTransport(fakeTronWeb(), { rpc: read.transport })({ chain: tron })
    for (const method of ['eth_getTransactionByHash', 'eth_getTransactionReceipt'])
      expect(await transport.request({ method, params: ['0xaa'] })).toBeNull()
  })

  it('read errors propagate: no fallback to TronWeb, no caching, no retry by this transport', async () => {
    const tronWeb = fakeTronWeb()
    const read = stubRead(() => ({ error: { code: -32603, message: 'node down' } }))
    const transport = tronWebTransport(tronWeb, { rpc: read.transport })({ chain: tron })
    for (let attempt = 0; attempt < 2; attempt++) {
      const error = await failure(transport.request({ method: 'eth_getCode', params: [CONTRACT] }))
      expect(error).toBeInstanceOf(InternalRpcError)
      expect((error as BaseError).details).toBe('node down')
    }
    expect(read.request).toHaveBeenCalledTimes(2)
    expect(callCounts(tronWeb)).toEqual(NONE)
  })

  it('results are not cached', async () => {
    const read = stubRead(() => ({ result: '0x6080' }))
    const transport = tronWebTransport(fakeTronWeb(), { rpc: read.transport })({ chain: tron })
    await transport.request({ method: 'eth_getCode', params: [CONTRACT, 'latest'] })
    await transport.request({ method: 'eth_getCode', params: [CONTRACT, 'latest'] })
    expect(read.request).toHaveBeenCalledTimes(2)
  })
})

describe('3. everything else', () => {
  it.each([
    'eth_getTransactionCount',
    'eth_sign',
    'personal_sign',
    'eth_sendRawTransaction',
    'eth_feeHistory',
    'eth_maxPriorityFeePerGas',
    'eth_newFilter',
    'eth_newBlockFilter',
    'eth_getFilterChanges',
    'eth_uninstallFilter',
    'eth_subscribe',
    'eth_unsubscribe',
    'eth_requestAccounts',
    'wallet_sendTransaction',
    'wallet_switchEthereumChain',
    'wallet_addEthereumChain',
    'eth_signTypedData_v3',
    'web3_clientVersion',
    'toString',
  ])('%s is MethodNotSupportedRpcError (-32004)', async (method) => {
    const tronWeb = fakeTronWeb()
    const read = stubRead(ok)
    const transport = tronWebTransport(tronWeb, { rpc: read.transport })({ chain: tron })
    const error = await failure(transport.request({ method, params: [] }))
    expect(error).toBeInstanceOf(MethodNotSupportedRpcError)
    expect((error as MethodNotSupportedRpcError).code).toBe(-32004)
    expect((error as MethodNotSupportedRpcError).shortMessage).toContain(method)
    expect(read.request).not.toHaveBeenCalled()
    expect(callCounts(tronWeb)).toEqual(NONE)
  })
})
