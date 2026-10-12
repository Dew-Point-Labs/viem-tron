import { type Hex, type TypedDataDefinition, hashTypedData } from 'viem'
import { to0x, walletAddress } from './address.js'
import { SigningError, guard, invalidParams, signingFailure } from './errors.js'
import { type TronWebLike, isRecord, toSafeInteger } from './types.js'

/**
 * `eth_signTypedData_v4`: the wallet signs the EIP-712 digest as a Tron signed message, that
 * is over `keccak256("\x19TRON Signed Message:\n32" ‖ digest)`. The result is not a raw
 * EIP-712 signature.
 */
export async function signTypedData(tronWeb: TronWebLike, params: unknown): Promise<Hex> {
  const [address, input] = (Array.isArray(params) ? params : []) as unknown[]
  const wallet = walletAddress(tronWeb)
  if (!wallet || to0x(tronWeb, address) !== wallet)
    throw invalidParams('The address must be the wallet account.')

  let typedData: unknown = input
  if (typeof input === 'string') {
    try {
      typedData = JSON.parse(input)
    } catch (thrown) {
      throw invalidParams('The typed data is not valid JSON.', thrown)
    }
  }
  if (
    !isRecord(typedData) ||
    !isRecord(typedData.types) ||
    !isRecord(typedData.domain) ||
    !isRecord(typedData.message) ||
    typeof typedData.primaryType !== 'string'
  )
    throw invalidParams(
      'Typed data needs object `types`, `domain`, `message` and a string `primaryType`.',
    )

  const domain = { ...typedData.domain }
  // Only when viem derives the domain type: older versions leave a non-number chainId out of
  // it. A declared `EIP712Domain` is hashed exactly as given.
  if (typedData.types.EIP712Domain === undefined && domain.chainId !== undefined) {
    domain.chainId = toSafeInteger(domain.chainId, true)
    if (domain.chainId === undefined)
      throw invalidParams('`domain.chainId` must be a non-negative safe integer.')
  }

  let digest: Hex
  try {
    digest = hashTypedData({ ...typedData, domain } as TypedDataDefinition)
  } catch (thrown) {
    throw invalidParams('The typed data could not be hashed.', thrown)
  }

  const signature = await guard(() => tronWeb.trx.sign(digest.slice(2)), signingFailure)
  const match =
    typeof signature === 'string'
      ? /^(?:0x)?(?<rs>[0-9a-f]{128})(?<v>00|01|1b|1c)$/i.exec(signature)
      : null
  if (!match?.groups?.rs || !match.groups.v)
    throw new SigningError('The signer did not return a 65-byte signature with a known v.', {
      cause: signature,
    })
  const { rs } = match.groups
  const v = parseInt(match.groups.v, 16)
  return `0x${rs.toLowerCase()}${(v < 27 ? v + 27 : v).toString(16)}`
}
