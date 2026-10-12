# @dewpointlabs/viem-tron

A [viem](https://viem.sh) transport for Tron. Wallet actions (sending transactions, signing typed data) go through a [TronWeb](https://tronweb.network) instance, either one your application creates or the one a wallet such as TronLink injects. Everything else is read from a Tron JSON-RPC endpoint.

Status: pre-release (0.x), not yet published to npm. The licence will be announced.

## How it works

One rule: reads go to a Tron JSON-RPC endpoint, wallet actions go to TronWeb.

- Nothing is emulated on top of TronWeb, and no value is fabricated. A method the endpoint does not answer is refused, not guessed.
- A wallet action is never retried by the transport and has no timeout (a wallet prompt waits for the user).
- `eth_chainId` and `net_version` are answered from the chain you pass to viem.

## Install

```sh
pnpm add @dewpointlabs/viem-tron viem
```

- Peer dependency: `viem >=2.21 <3`. There are no runtime dependencies.
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

`rpc` is a URL, or a viem transport that is used as given.

```ts
import { fallback, http } from 'viem'

// A URL: the package builds http(url, { retryCount, retryDelay, timeout }).
tronWebTransport(tronWeb, {
  rpc: 'https://api.trongrid.io/jsonrpc',
  retryCount: 2,
  timeout: 10_000,
})

// A viem transport: its own options apply.
tronWebTransport(tronWeb, {
  rpc: http('https://api.trongrid.io/jsonrpc', {
    fetchOptions: { headers: { 'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY ?? '' } },
  }),
})
tronWebTransport(tronWeb, {
  rpc: fallback([http('https://rpc-a.example/jsonrpc'), http('https://rpc-b.example/jsonrpc')]),
})
```

Without `rpc`, the first default HTTP URL of the chain is used. Creating the transport throws viem's `UrlRequiredError` when there is none, and a `BaseError` when no `chain` is given.

## Configuration

`tronWebTransport(tronWeb, config?)`. Every key is optional.

| Key          | Type                  | Default                             | Meaning                                                                          |
| ------------ | --------------------- | ----------------------------------- | -------------------------------------------------------------------------------- |
| `rpc`        | `string \| Transport` | first default HTTP URL of the chain | Where reads go. A string becomes viem `http(url)`; a transport is used as given. |
| `feeLimit`   | `number`              | `300_000_000` (300 TRX)             | Upper bound a contract call may burn, in SUN. Must be a positive safe integer.   |
| `key`        | `string`              | `'tronWeb'`                         | viem transport key.                                                              |
| `name`       | `string`              | `'TronWeb'`                         | viem transport name.                                                             |
| `retryCount` | `number`              | viem `http()` default               | Retries of a failed read. Applies only when `rpc` is a string.                   |
| `retryDelay` | `number` (ms)         | viem `http()` default               | Base delay between read retries. Applies only when `rpc` is a string.            |
| `timeout`    | `number` (ms)         | viem `http()` default               | Timeout of a read. Applies only when `rpc` is a string.                          |

When `rpc` is a transport, the three read options are ignored; configure them on that transport. Wallet actions are never retried and have no timeout, whatever these values are.

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
3. Simulate it with `triggerConstantContract` (contract calls only).
4. Sign it with the wallet (`trx.sign`).
5. Broadcast it (`trx.sendRawTransaction`) and return the transaction id (`0x` + id). The transport does not wait for confirmation.

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

Known limitation: with viem versions that derive the `EIP712Domain` type themselves, pass `domain.chainId` as a number (not a `bigint` or a string) when signing through `walletClient.signTypedData`. Otherwise viem may leave `chainId` out of the derived domain type before the transport sees the request.

## Errors

Where viem has a class, it is used:

| Class                        | Thrown when                                                     |
| ---------------------------- | --------------------------------------------------------------- |
| `UserRejectedRequestError`   | The user refused to sign (code 4001).                           |
| `InvalidParamsRpcError`      | Malformed parameters, wrong sender, contract creation (-32602). |
| `MethodNotSupportedRpcError` | The method is outside the lists above (-32004).                 |
| `UrlRequiredError`           | No read endpoint at construction.                               |

The package adds six classes. They extend viem's `BaseError`, keep the original error in `cause`, and have no `code`.

| Class                         | Extra fields            | Thrown when                                                                                                                                            |
| ----------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TransactionRevertedError`    | `reason?`, `data?`      | The simulation reverted or ran out of energy. `reason` is `'OUT_OF_ENERGY'` in the latter case; `data` holds revert bytes when the node returned them. |
| `SimulationUnavailableError`  |                         | The simulation could not be performed.                                                                                                                 |
| `TransactionBuildError`       |                         | The node refused to build the transaction.                                                                                                             |
| `SigningError`                |                         | The signer failed or returned an unusable result.                                                                                                      |
| `BroadcastError`              | `nodeCode?`             | The node refused the signed transaction.                                                                                                               |
| `BroadcastIndeterminateError` | `transactionId`, `data` | The broadcast outcome is unknown (next section).                                                                                                       |

All are exported from the package root.

### What you catch

- `transport.request(...)` and `walletClient.signTypedData(...)`: viem's own classes arrive as a new instance of the same class (so `instanceof` and `code` hold), and the package's classes arrive as the same instance.
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

- An EIP-1193 wrapper such as ethers `BrowserProvider`: only `code`, `data` and `message` survive. The package's own errors have no `code`; `BroadcastIndeterminateError` carries its id in `data`.
- If your bundle contains two copies of viem, `instanceof BaseError` fails inside viem, and the package's errors arrive as the `cause` of an `UnknownRpcError`. They are still not retried. Deduplicate viem to avoid this.

## Broadcast outcome unknown

`BroadcastIndeterminateError` means the signed transaction was handed to TronWeb but the answer was lost or unrecognisable (a timeout, a dropped connection, an unexpected reply). **The transaction may have been accepted.** Do not send it again blindly. The error has `transactionId` (and the same id in `data.transactionId`); look it up first:

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

Development and the test run need Node 22.12 or newer; CI runs 22 and 24. The built package supports Node 20 and newer (`engines.node`).

### Contributing

Write the test first. Add no runtime dependencies. Keep the public surface small: new exports need a clear reason. Run the commands above before opening a pull request.

### Security

See [SECURITY.md](SECURITY.md).

### Versioning

Semantic versioning. While the version is 0.x, breaking changes may land in a minor release; they are recorded in [CHANGELOG.md](CHANGELOG.md).
