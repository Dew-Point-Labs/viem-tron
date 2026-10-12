# @dewpointlabs/viem-tron

A viem transport for Tron: wallet actions go through TronWeb (for example TronLink), and reads go through Tron JSON-RPC.

Status: pre-release, not published.

## Development

```sh
pnpm install
pnpm lint            # eslint + prettier check
pnpm typecheck       # tsc --noEmit
pnpm test            # vitest with coverage thresholds
pnpm build           # tsup, ESM + CJS + types
pnpm check:package   # pack, install in a clean project, publint, attw
```
