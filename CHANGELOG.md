# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

### Added

- `tronWebTransport(tronWeb, config?)`: a viem transport for Tron. Wallet actions go through a TronWeb instance (created by the application or injected by a wallet); reads go to a Tron JSON-RPC endpoint.
- `eth_sendTransaction` for contract calls and TRX transfers. `value` is in SUN. Calldata is forwarded unchanged. A contract call is simulated first, and nothing is signed when the simulation reverts, runs out of energy or cannot be performed. Returns the transaction id without waiting for confirmation.
- `eth_signTypedData_v4` (alias `eth_signTypedData`): the wallet signs the EIP-712 digest as a Tron signed message; the result is a 65-byte signature with `v` as 27 or 28.
- `eth_chainId`, `net_version` and `eth_accounts` answered locally.
- Reads forwarded to the JSON-RPC endpoint: `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getBlockByHash`, `eth_getBalance`, `eth_call`, `eth_estimateGas`, `eth_getCode`, `eth_getStorageAt`, `eth_getLogs`, `eth_gasPrice`, `eth_getTransactionByHash`, `eth_getTransactionReceipt`. Base58 and 41-prefixed addresses in `eth_call` / `eth_estimateGas` are converted, and a missing `from` is filled with the wallet account. A transaction or receipt that is not yet included is reported with standard `null` values.
- Every other method is refused with viem's `MethodNotSupportedRpcError`.
- Configuration: `rpc` (URL or viem transport for reads), `feeLimit` (SUN, default 300,000,000), `key`, `name`, and `retryCount` / `retryDelay` / `timeout` for reads when `rpc` is a URL. Wallet actions are never retried and have no timeout.
- Error classes: `TransactionRevertedError`, `SimulationUnavailableError`, `TransactionBuildError`, `SigningError`, `BroadcastError` and `BroadcastIndeterminateError`. The last one carries the transaction id for the case where the broadcast outcome is unknown. A refusal in the wallet is reported as viem's `UserRejectedRequestError`, invalid input as `InvalidParamsRpcError`.
- Types: `TronWebLike`, `TronWebTransport`, `TronWebTransportConfig`.
