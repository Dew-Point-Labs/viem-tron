# @dewpointlabs/viem-tron

A [viem](https://viem.sh) transport for Tron. Wallet actions (sending transactions, signing typed data) go through a [TronWeb](https://tronweb.network) instance, either one your application creates or the one a wallet such as TronLink injects. Everything else is read from a Tron JSON-RPC endpoint.

Status: pre-release (0.x), not yet published to npm. The licence will be announced.

## How it works

One rule: reads go to a Tron JSON-RPC endpoint, wallet actions go to TronWeb.

- Nothing is emulated on top of TronWeb, and no value is fabricated. A method the endpoint does not answer is refused, not guessed.
- A wallet action is issued at most once per request and has no timeout (a wallet prompt waits for the user). See [No repeated wallet actions](#no-repeated-wallet-actions).
- `eth_chainId` and `net_version` are answered from the chain you pass to viem.

## Install

```sh
pnpm add @dewpointlabs/viem-tron viem
```

- Peer dependency: `viem >=2.21.55 <3`. There are no runtime dependencies.
- Node 22 or newer, or a current browser.
- The package does not import TronWeb. Your application installs `tronweb` if it needs its own instance; in a browser the wallet provides one.

## Quick start

### Wallet-injected TronWeb

Use `window.tronWeb` once the wallet is connected and has an account.

```ts
import { createWalletClient } from 'viem'
import { tron } from 'viem/chains'
import { tronWebTransport, type TronWebLike } from '@dewpointlabs/viem-tron'

const tronWeb = (window as unknown as { tronWeb: TronWebLike }).tronWeb
const client = createWalletClient({ chain: tron, transport: tronWebTransport(tronWeb) })

const [account] = await client.getAddresses() // the wallet account, in 0x form
if (!account) throw new Error('Connect the wallet first')
const hash = await client.sendTransaction({
  account,
  to: '0xa614f803b6fd780986a42c78ec9c7f77e6ded13c',
  value: 1_000_000n, // SUN: 1 TRX
})
```

### Key-backed TronWeb in Node

```ts
import { createWalletClient } from 'viem'
import { tron } from 'viem/chains'
import { TronWeb } from 'tronweb'
import { tronWebTransport } from '@dewpointlabs/viem-tron'

const privateKey = process.env.TRON_PRIVATE_KEY
if (!privateKey) throw new Error('Set TRON_PRIVATE_KEY')

const tronWeb = new TronWeb({ fullHost: 'https://api.trongrid.io', privateKey })
const client = createWalletClient({ chain: tron, transport: tronWebTransport(tronWeb) })
const [account] = await client.getAddresses()
if (!account) throw new Error('The TronWeb instance has no account')
```

### Custom read endpoint

`rpc` is a URL, or a viem transport that is used as given. Pass a transport to set retries, a timeout or headers.

```ts
import { fallback, http } from 'viem'

// A URL: the package builds a plain http(url).
tronWebTransport(tronWeb, { rpc: 'https://api.trongrid.io/jsonrpc' })

// A viem transport: its own options apply.
tronWebTransport(tronWeb, {
  rpc: http('https://api.trongrid.io/jsonrpc', {
    retryCount: 2,
    timeout: 10_000,
    fetchOptions: { headers: { 'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY ?? '' } },
  }),
})
tronWebTransport(tronWeb, {
  rpc: fallback([http('https://rpc-a.example/jsonrpc'), http('https://rpc-b.example/jsonrpc')]),
})
```

Without `rpc`, the first default HTTP URL of the chain is used. Creating the transport throws viem's `UrlRequiredError` when there is none, and a `BaseError` when no `chain` is given.

## Configuration

`tronWebTransport(tronWeb, config?)`. Both keys are optional.

| Key        | Type                  | Default                             | Meaning                                                                          |
| ---------- | --------------------- | ----------------------------------- | -------------------------------------------------------------------------------- |
| `rpc`      | `string \| Transport` | first default HTTP URL of the chain | Where reads go. A string becomes viem `http(url)`; a transport is used as given. |
| `feeLimit` | `number`              | `300_000_000` (300 TRX)             | Upper bound a contract call may burn, in SUN. Must be a positive safe integer.   |

The transport's viem `key` and `name` are fixed: `'tronWeb'` and `'TronWeb'`.

## Supported methods

Handled through TronWeb or locally:

- `eth_sendTransaction`
- `eth_signTypedData_v4` (and its alias `eth_signTypedData`)
- `eth_accounts`: the wallet account in 0x form, or `[]` when the wallet has none
- `eth_chainId`, `net_version`: from the chain

Forwarded to the JSON-RPC endpoint:

- `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getBlockByHash`
- `eth_getBalance`, `eth_getCode`, `eth_getStorageAt`
- `eth_call`, `eth_estimateGas`
- `eth_getLogs`, `eth_gasPrice`
- `eth_getTransactionByHash`, `eth_getTransactionReceipt`

Three adjustments are made to forwarded requests and answers:

- `eth_call` / `eth_estimateGas`: `to` and `from` given as base58 or 41-prefixed hex are converted to 0x (a malformed one is an `InvalidParamsRpcError`). A missing `from` is filled with the wallet account when there is one, because contracts that check `msg.sender` simulate differently without it.
- `eth_getTransactionByHash`: for a transaction that is not yet included, java-tron's `"0x"` in `blockHash`, `blockNumber` and `transactionIndex` becomes `null`, and `"0x"` in `gasPrice` becomes `"0x0"`.
- `eth_getTransactionReceipt`: a receipt without a `blockHash`, `blockNumber` or `status` (not final yet) is returned as `null`.

Errors from the read endpoint propagate unchanged; there is no fallback to TronWeb.

Not supported: every other method is refused with viem's `MethodNotSupportedRpcError` (code -32004). Notable cases: `eth_getTransactionCount` (Tron accounts have no nonce), `eth_sign`, `personal_sign`, `eth_sendRawTransaction`, `eth_feeHistory`, `eth_maxPriorityFeePerGas`, filters and subscriptions, `eth_requestAccounts`, `wallet_*`.

## Sending transactions

`eth_sendTransaction` runs these steps in order and stops at the first failure:

1. Validate the parameters (`InvalidParamsRpcError` on any problem).
2. Build the transaction: `triggerSmartContract` for a contract call, `sendTrx` for a TRX transfer.
3. Check the built transaction against the request: one contract entry of the expected type with the requested sender, recipient, calldata and amount. Anything else is a `TransactionBuildError`.
4. Simulate it with `triggerConstantContract` (contract calls only).
5. Sign it with the wallet (`trx.sign`). The wallet gets its own object; a returned transaction id that differs from the built one, or a signature that is not 65 bytes, is a `SigningError`.
6. Broadcast the built transaction with the wallet's signatures (`trx.sendRawTransaction`) and return the transaction id (`0x` + id). The transport does not wait for confirmation.

Accepted fields: `from`, `to`, `data` (or `input`), `value`, `permissionId`. Gas, fee, nonce, chain id, type and access-list fields are ignored.

- **Units: `value` and `feeLimit` are in SUN (1 TRX = 1,000,000 SUN).** No scaling is done. `value` is a `bigint`, a safe-integer number or a `0x` quantity; decimal strings are rejected.
- Calldata is forwarded unchanged, byte for byte. It must be `0x`-prefixed hex of even length; if `data` and `input` are both present they must be equal.
- `to` may be a 0x, 41-prefixed hex or base58 address. A transaction without `to` (contract creation) is not supported.
- A transaction needs calldata or a positive `value`.
- The sender must be the wallet account. `from` may be omitted; if given it must equal the account, and a wallet without an account is an error.
- Nothing is signed if the simulation reverts, runs out of energy or cannot be run.

## Signing typed data

`eth_signTypedData_v4` computes the standard EIP-712 digest with viem's `hashTypedData` and asks the wallet to sign it as a Tron signed message. The result is a 65-byte signature with `v` of 27 or 28.

> **This is not a raw EIP-712 signature.** The signature is over `keccak256("\x19TRON Signed Message:\n32" ‖ digest)`. A plain `ecrecover(digest, signature)` returns an unrelated address.

To recover the signer:

```ts
import { concat, hashTypedData, keccak256, recoverAddress, stringToHex } from 'viem'

const digest = hashTypedData(typedData)
const hash = keccak256(concat([stringToHex('\x19TRON Signed Message:\n32'), digest]))
const signer = await recoverAddress({ hash, signature })
```

`typedData` is the same `{ domain, types, primaryType, message }` that was signed. The domain is used as given; nothing is injected.

`domain.chainId`:

- When `types` has no `EIP712Domain` entry, viem derives it, and a `chainId` given as a hex string, a decimal string or a `bigint` is converted to a number first, so that it is part of the digest on every viem version.
- When `types` declares `EIP712Domain`, the domain is hashed exactly as given.

Known limitation: `walletClient.signTypedData` always sends a domain type that viem derived itself. On viem versions that derive it only from a numeric `chainId` (2.21.55 does), a `bigint` or string `chainId` is left out of the digest before the transport sees the request. Pass `domain.chainId` as a number there.

## Errors

Where viem has a class, it is used:

| Class                        | Thrown when                                                     |
| ---------------------------- | --------------------------------------------------------------- |
| `UserRejectedRequestError`   | The user refused to sign (code 4001).                           |
| `InvalidParamsRpcError`      | Malformed parameters, wrong sender, contract creation (-32602). |
| `MethodNotSupportedRpcError` | The method is outside the lists above (-32004).                 |
| `UrlRequiredError`           | No read endpoint at construction.                               |

The package adds six classes. They extend the exported base class `TronWebTransportError` (a viem `BaseError`), keep the original error or node answer in `cause`, and all carry `code` -32003. viem neither retries that code nor hands it to the next transport of a `fallback()`.

| Class                         | Extra fields            | Thrown when                                                                                                                                            |
| ----------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TransactionRevertedError`    | `reason?`, `data?`      | The simulation reverted or ran out of energy. `reason` is `'OUT_OF_ENERGY'` in the latter case; `data` holds revert bytes when the node returned them. |
| `SimulationUnavailableError`  |                         | The simulation could not be performed.                                                                                                                 |
| `TransactionBuildError`       |                         | The transaction could not be built, or what was built differs from the request.                                                                        |
| `SigningError`                |                         | The signer failed or returned an unusable result.                                                                                                      |
| `BroadcastError`              | `nodeCode?`             | The node refused the signed transaction.                                                                                                               |
| `BroadcastIndeterminateError` | `transactionId`, `data` | The broadcast outcome is unknown (next section).                                                                                                       |

All are exported from the package root.

### What you catch

- `transport.request(...)` and `walletClient.signTypedData(...)`: viem's own classes arrive as a new instance of the same class (so `instanceof` and `code` hold). The package's classes arrive as the `cause` of viem's `TransactionRejectedRpcError` (code -32003); find them with `error.walk((e) => e instanceof TronWebTransportError)`.
- `walletClient.sendTransaction(...)`: viem wraps everything in `TransactionExecutionError`. Find the error you want with `walk`:

  ```ts
  import { type BaseError, UserRejectedRequestError } from 'viem'
  import { TransactionRevertedError } from '@dewpointlabs/viem-tron'

  try {
    await client.sendTransaction({ account, to, data })
  } catch (error) {
    const reverted = (error as BaseError).walk((e) => e instanceof TransactionRevertedError)
    if (reverted) console.error('would revert', reverted)
    else if ((error as BaseError).walk((e) => e instanceof UserRejectedRequestError))
      console.error('user refused')
    else throw error
  }
  ```

- An EIP-1193 wrapper such as ethers `BrowserProvider`: only `code`, `data` and `message` survive. Every error of this package has `code` -32003, and its text is part of the outer error's `message`. `data.transactionId` is on `BroadcastIndeterminateError` itself, not on viem's wrapper, so read it from the walked error before the error leaves viem.
- Two copies of viem in one bundle do not change this: viem maps these errors by `code`.

## No repeated wallet actions

One request causes at most one build, one simulation, one wallet prompt and one broadcast:

- the transport never retries, and it ignores a `retryCount` passed with a single request;
- every failure on the wallet path carries a code (-32003, or 4001 for a refusal by the user) that viem does not retry and that makes `fallback([...])` stop instead of trying its next transport.

Invalid parameters and unsupported methods are refused before TronWeb is asked for anything; a `fallback()` does try its next transport for those.

## Broadcast outcome unknown

`BroadcastIndeterminateError` means the signed transaction was handed to TronWeb but the answer was lost or unrecognisable (a timeout, a dropped connection, an unexpected reply), or the node answered that it already has this transaction (`DUP_TRANSACTION_ERROR`). **The transaction may have been accepted.** Do not send it again blindly. The error has `transactionId` (and the same id in `data.transactionId`); look it up first:

```ts
import { type BaseError, createPublicClient } from 'viem'
import { tron } from 'viem/chains'
import { BroadcastIndeterminateError, tronWebTransport } from '@dewpointlabs/viem-tron'

const publicClient = createPublicClient({ chain: tron, transport: tronWebTransport(tronWeb) })

try {
  await client.sendTransaction({ account, to, data })
} catch (error) {
  const unknown = (error as BaseError).walk((e) => e instanceof BroadcastIndeterminateError)
  if (!(unknown instanceof BroadcastIndeterminateError)) throw error
  const found = await publicClient.request({
    method: 'eth_getTransactionByHash',
    params: [unknown.transactionId],
  })
  // null: not seen yet, check again later before resending. Otherwise it was accepted.
}
```

A node that has not seen the transaction yet also answers `null`, so a single `null` is not proof that it was dropped.

## Not included

- `personal_sign` and `eth_sign` (message signing).
- `eth_sendRawTransaction` (raw transactions).
- Contract deployment.
- Confirmation helpers: the transaction id is returned without waiting.
- A TronWeb-only read mode: reads always need a JSON-RPC endpoint.

## Development

```sh
pnpm install
pnpm lint            # eslint + prettier check
pnpm typecheck       # tsc --noEmit
pnpm test            # vitest with coverage thresholds
pnpm build           # tsup, ESM + CJS + types
pnpm check:package   # pack, install in a clean project, publint, attw
pnpm check:live      # manual read-only probe of the built package against Shasta (not run in CI)
```

Node 22.12 or newer is needed for development; CI runs 22 and 24. The package itself declares Node 22 or newer (`engines.node`).

### Contributing

Write the test first. Add no runtime dependencies. Keep the public surface small: new exports need a clear reason. Run the commands above before opening a pull request.

### Security

See [SECURITY.md](SECURITY.md).

### Versioning

Semantic versioning. While the version is 0.x, breaking changes may land in a minor release; they are recorded in [CHANGELOG.md](CHANGELOG.md).
