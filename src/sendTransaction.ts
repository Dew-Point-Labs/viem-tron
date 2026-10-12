import type { Address, Hex } from 'viem'
import { to0x, toBase58, walletAddress } from './address.js'
import {
  BroadcastError,
  BroadcastIndeterminateError,
  SigningError,
  SimulationUnavailableError,
  TransactionBuildError,
  TransactionRevertedError,
  guard,
  invalidParams,
  messageOf,
  signingFailure,
} from './errors.js'
import { HEX_BYTES, type TronWebLike, isRecord, toSafeInteger } from './types.js'

/** Text of a thrown value, or the `result.message` of an answer the builder returned. */
const nodeText = (source: unknown) =>
  messageOf(isRecord(source) && isRecord(source.result) ? source.result : source)

const buildError = (source: unknown) =>
  new TransactionBuildError(
    `The transaction could not be built: ${nodeText(source) || 'unexpected answer from the node'}`,
    source,
  )

function simulationFailed(simulated: Record<string, unknown>): boolean {
  const ret = isRecord(simulated.transaction) ? simulated.transaction.ret : undefined
  const first: unknown = Array.isArray(ret) ? ret[0] : undefined
  return isRecord(first) && first.ret === 'FAILED'
}

function simulationError(source: unknown): Error {
  const simulated = isRecord(source) ? source : {}
  const text = nodeText(source)
  const bytes: unknown = Array.isArray(simulated.constant_result)
    ? simulated.constant_result[0]
    : undefined
  const data: Hex | undefined =
    typeof bytes === 'string' && HEX_BYTES.test(bytes) ? `0x${bytes}` : undefined
  const outOfEnergy = /out.?of.?energy/i.test(text)
  if (outOfEnergy || /revert/i.test(text) || simulationFailed(simulated))
    return new TransactionRevertedError(
      outOfEnergy
        ? 'The transaction would run out of energy.'
        : `The transaction would revert: ${text || 'no reason given'}`,
      source,
      outOfEnergy ? 'OUT_OF_ENERGY' : undefined,
      data,
    )
  return new SimulationUnavailableError(
    `The transaction could not be simulated: ${text || 'unexpected answer from the node'}`,
    source,
  )
}

interface Request {
  from: Address
  to: Address
  calldata: string
  value: number
}

/**
 * Whether a built transaction is exactly the requested call or transfer: a node or builder
 * must not be able to swap what the user is asked to sign.
 */
function matchesRequest(
  tronWeb: TronWebLike,
  transaction: Record<string, unknown>,
  request: Request,
): boolean {
  const contracts = isRecord(transaction.raw_data) ? transaction.raw_data.contract : undefined
  if (!Array.isArray(contracts) || contracts.length !== 1) return false
  const contract: unknown = contracts[0]
  if (!isRecord(contract) || !isRecord(contract.parameter)) return false
  const { value } = contract.parameter
  if (!isRecord(value) || to0x(tronWeb, value.owner_address) !== request.from) return false

  if (request.calldata === '0x')
    return (
      contract.type === 'TransferContract' &&
      to0x(tronWeb, value.to_address) === request.to &&
      (value.amount ?? 0) === request.value
    )
  return (
    contract.type === 'TriggerSmartContract' &&
    to0x(tronWeb, value.contract_address) === request.to &&
    (value.call_value ?? 0) === request.value &&
    typeof value.data === 'string' &&
    `0x${value.data}`.toLowerCase() === request.calldata.toLowerCase()
  )
}

/**
 * `eth_sendTransaction`: validate, build, simulate, sign and broadcast through TronWeb.
 * `value` and `feeLimit` are in SUN. Returns `0x` + the transaction id without waiting for
 * confirmation.
 */
export async function sendTransaction(
  tronWeb: TronWebLike,
  feeLimit: number,
  params: unknown,
): Promise<Hex> {
  const tx: unknown = Array.isArray(params) ? params[0] : undefined
  if (!isRecord(tx)) throw invalidParams('The first parameter must be a transaction object.')

  if (tx.to == null) throw invalidParams('`to` is required: contract creation is not supported.')
  const to = to0x(tronWeb, tx.to)
  if (!to) throw invalidParams('`to` is not a valid address.')

  const calldata = tx.data ?? tx.input ?? '0x'
  if (typeof calldata !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(calldata))
    throw invalidParams('Calldata must be 0x-prefixed even-length hex.')
  if (
    tx.data != null &&
    tx.input != null &&
    (typeof tx.input !== 'string' || tx.input.toLowerCase() !== calldata.toLowerCase())
  )
    throw invalidParams('`data` and `input` are both present and differ.')

  const value = tx.value == null ? 0 : toSafeInteger(tx.value)
  if (value === undefined)
    throw invalidParams('`value` must be a 0x quantity, a bigint or a safe integer, in SUN.')

  const permission: { permissionId?: number } = {}
  if (tx.permissionId != null) {
    if (typeof tx.permissionId !== 'number' || toSafeInteger(tx.permissionId) === undefined)
      throw invalidParams('`permissionId` must be a non-negative safe integer.')
    permission.permissionId = tx.permissionId
  }

  // Read once: a wallet can switch account between the check and the build.
  const from = walletAddress(tronWeb)
  if (!from) throw invalidParams('The wallet has no account.')
  if (tx.from != null && to0x(tronWeb, tx.from) !== from)
    throw invalidParams(`\`from\` must be the wallet account ${from}.`)

  const isCall = calldata !== '0x'
  if (!isCall && value === 0)
    throw invalidParams('A transaction needs calldata or a positive `value`.')

  const [recipient, sender] = [toBase58(tronWeb, to), toBase58(tronWeb, from)]
  // The calldata goes out byte for byte as `input`; an empty selector makes TronWeb use it.
  const call = { input: calldata.slice(2), ...(value > 0 && { callValue: value }), ...permission }
  const builder = tronWeb.transactionBuilder

  const built = await guard(
    () =>
      isCall
        ? builder.triggerSmartContract(recipient, '', { feeLimit, ...call }, [], sender)
        : builder.sendTrx(recipient, value, sender, permission),
    buildError,
  )
  const accepted = isRecord(built) && isRecord(built.result) && built.result.result === true
  const fromBuilder = !isCall ? built : accepted ? built.transaction : undefined
  if (!isRecord(fromBuilder)) throw buildError(built)
  // A private copy: a wallet may mutate the object it signs, and only what was built here may
  // reach the node.
  const transaction = await guard(
    () => structuredClone(fromBuilder),
    () => buildError(built),
  )
  const { txID } = transaction
  if (typeof txID !== 'string' || !/^[0-9a-f]{64}$/i.test(txID)) throw buildError(built)

  if (!matchesRequest(tronWeb, transaction, { from, to, calldata, value }))
    throw new TransactionBuildError('The built transaction does not match the request.', built)

  if (isCall) {
    const simulated = await guard(
      () => builder.triggerConstantContract(recipient, '', call, [], sender),
      simulationError,
    )
    if (
      !isRecord(simulated) ||
      !isRecord(simulated.result) ||
      simulated.result.result !== true ||
      simulated.result.message !== undefined ||
      simulationFailed(simulated)
    )
      throw simulationError(simulated)
  }

  const signed = await guard(() => tronWeb.trx.sign(fromBuilder), signingFailure)
  const isSignature = (entry: unknown) =>
    typeof entry === 'string' && /^(?:0x)?[0-9a-f]{130}$/i.test(entry)
  if (
    !isRecord(signed) ||
    !Array.isArray(signed.signature) ||
    signed.signature.length === 0 ||
    !signed.signature.every(isSignature) ||
    signed.txID !== txID
  )
    throw new SigningError('The signer returned an unusable result.', signed)

  const id: Hex = `0x${txID.toLowerCase()}`
  const answer = await guard(
    () => tronWeb.trx.sendRawTransaction({ ...transaction, signature: signed.signature }),
    (thrown) => new BroadcastIndeterminateError(id, thrown),
  )
  if (isRecord(answer)) {
    if (answer.result === true) return id
    // The node already knows this transaction, so an earlier broadcast may have gone through.
    const duplicate = answer.code === 'DUP_TRANSACTION_ERROR'
    if (!duplicate && (answer.result === false || answer.code != null))
      throw new BroadcastError(
        `The node refused the transaction: ${messageOf(answer) || 'no message'}`,
        answer,
        typeof answer.code === 'string' ? answer.code : undefined,
      )
  }
  throw new BroadcastIndeterminateError(id, answer)
}
