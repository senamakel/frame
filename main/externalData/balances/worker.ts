import log from 'electron-log'
import ethProvider from 'eth-provider'

log.transports.console.format = '[scanWorker] {h}:{i}:{s}.{ms} {text}'
log.transports.console.level = process.env.LOG_WORKER ? 'debug' : 'info'
log.transports.file.level = ['development', 'test'].includes(process.env.NODE_ENV || 'development')
  ? false
  : 'verbose'

import { supportsChain as chainSupportsScan } from '../../multicall'
import balancesLoader, { BalanceLoader, TokenBalance } from './scan'
import TokenLoader from '../inventory/tokens'
import { toTokenId } from '../../../resources/domain/balance'

interface ExternalDataWorkerMessage {
  command: string
  args: any[]
}

let heartbeat: NodeJS.Timeout
let balances: BalanceLoader

const eth = ethProvider('frame', { origin: 'frame-internal', name: 'scanWorker' })
const tokenLoader = new TokenLoader()

eth.on('error', (e) => {
  log.error('Error in balances worker', e)
  disconnect()
})

eth.on('connect', async () => {
  await tokenLoader.start()

  balances = balancesLoader(eth)

  sendToMainProcess({ type: 'ready' })
})

async function getChains() {
  try {
    const chains: string[] = await eth.request({ method: 'wallet_getChains' })
    return chains.map((chain) => parseInt(chain))
  } catch (e) {
    log.error('could not load chains', e)
    return []
  }
}

function sendToMainProcess(data: any) {
  if (process.send) {
    return process.send(data)
  } else {
    log.error(`cannot send to main process! connected: ${process.connected}`)
  }
}

async function updateBlacklist(address: Address, chains: number[]) {
  try {
    const blacklistTokens = tokenLoader.getBlacklist(chains)
    sendToMainProcess({ type: 'tokenBlacklist', address, tokens: blacklistTokens })
  } catch (e) {
    log.error('error updating token blacklist', e)
  }
}

async function tokenBalanceScan(address: Address, tokensToOmit: Token[] = [], chains: number[]) {
  try {
    // for chains that support multicall, we can attempt to load every token that we know about,
    // for all other chains we need to call each contract individually so don't scan every contract
    const omitSet = new Set(tokensToOmit.map(toTokenId))
    const eligibleChains = (chains || (await getChains())).filter(chainSupportsScan)
    const tokenList = tokenLoader.getTokens(eligibleChains)
    const tokens = tokenList.filter((token) => !omitSet.has(toTokenId(token)))

    const tokenBalances = (await balances.getTokenBalances(address, tokens)).filter(
      (balance) => parseInt(balance.balance) > 0
    )

    sendToMainProcess({ type: 'tokenBalances', address, balances: tokenBalances })
  } catch (e) {
    log.error('error scanning for token balances', e)
  }
}

async function fetchTokenBalances(address: Address, tokens: Token[]) {
  try {
    const blacklistSet = new Set(tokenLoader.getBlacklist().map(toTokenId))
    const filteredTokens = tokens.filter((token) => !blacklistSet.has(toTokenId(token)))
    const tokenBalances = await balances.getTokenBalances(address, filteredTokens)

    sendToMainProcess({ type: 'tokenBalances', address, balances: tokenBalances })
  } catch (e) {
    log.error('error fetching token balances', e)
  }
}

async function chainBalanceScan(address: string, chains?: number[]) {
  try {
    const availableChains = chains || (await getChains())
    const chainBalances = await balances.getCurrencyBalances(address, availableChains)

    sendToMainProcess({ type: 'chainBalances', balances: chainBalances, address })
  } catch (e) {
    log.error('error scanning chain balance', e)
  }
}

function disconnect() {
  process.disconnect()
  process.kill(process.pid, 'SIGHUP')
}

function resetHeartbeat() {
  clearTimeout(heartbeat)

  heartbeat = setTimeout(() => {
    log.warn('no heartbeat received in 60 seconds, worker exiting')
    disconnect()
  }, 60 * 1000)
}

const messageHandler: { [command: string]: (...params: any) => void } = {
  updateChainBalance: chainBalanceScan,
  fetchTokenBalances: fetchTokenBalances,
  heartbeat: resetHeartbeat,
  tokenBalanceScan: (address, tokensToOmit, chains) => {
    updateBlacklist(address, chains)
    tokenBalanceScan(address, tokensToOmit, chains)
  }
}

process.on('message', (message: ExternalDataWorkerMessage) => {
  log.debug(`received message: ${message.command} [${message.args}]`)

  const args = message.args || []
  messageHandler[message.command](...args)
})
