# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub Security Advisories on this repository; do not open public issues.

## Supported versions

The latest 0.x release.

## Scope

The transport never handles private keys. Signing happens in the wallet or in the TronWeb instance that the application supplies.

In scope: anything that could cause

- a transaction to be signed or broadcast with a different content, sender or amount than the one requested;
- a transaction to be signed after a failed or unavailable simulation;
- a wallet action (send or sign) to be issued more than once for one request.

Out of scope: vulnerabilities in viem, TronWeb, wallets or Tron nodes themselves; report those to their maintainers.
