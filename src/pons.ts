import { decodeEventLog, parseAbi, parseAbiItem, encodeAbiParameters, keccak256, type Hex } from 'viem';

export const FACTORIES = [
  { address: '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e', version: 'pons-v2' },
  { address: '0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb', version: 'pons-v1' },
  { address: '0x0c37a24f5d23a486fa692d1500881d698b1f77a4', version: 'pons-v1-legacy' },
] as const;
export const V2_HOOK = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044';
export const v2Launch = parseAbiItem('event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)');
export const v1Launch = parseAbiItem('event TokenLaunched(address indexed token, address indexed deployer, address indexed dexFactory, address pairToken, address pool, uint256 dexId, uint256 launchConfigId, uint256 positionId, uint256 restrictionsEndBlock, uint256 initialBuyAmount)');
export const curveBuy = parseAbiItem('event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)');
export const curveSell = parseAbiItem('event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)');
export const v3Swap = parseAbiItem('event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)');
export const stateAbi = parseAbi([
  'struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }',
  'function getLaunchedToken(address token) view returns (LaunchedToken)',
]);
export const reserveAbi = parseAbi([
  'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
  'function realQuoteReserve() view returns (uint256)',
]);
export const metadataAbi = parseAbi(['function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)']);
export type RpcLog = { address: string; topics: Hex[]; data: Hex; blockNumber: Hex; blockHash: Hex; transactionHash: Hex; logIndex: Hex; removed?: boolean };
export type Launch = { tokenAddress: string; deployerAddress: string; factory: string; version: string; quoteAsset: string; curveAddress: string | null; poolAddress: string | null; launchBlock: number; launchTime: number; discoveredAt: number; blockHash: string; transactionHash: string; logIndex: number };
export function decodeLaunch(log: RpcLog, version: string, timestamp: number, now: number): Launch {
  if (log.removed) throw new Error('Removed launch log');
  const decoded = decodeEventLog({ abi: [version === 'pons-v2' ? v2Launch : v1Launch], topics: log.topics as [Hex, ...Hex[]], data: log.data });
  const a = decoded.args as any;
  return { tokenAddress: a.token.toLowerCase(), deployerAddress: a.deployer.toLowerCase(), factory: log.address.toLowerCase(), version,
    quoteAsset: a.pairToken.toLowerCase(), curveAddress: a.curve?.toLowerCase() ?? null, poolAddress: a.pool?.toLowerCase() ?? null,
    launchBlock: Number(BigInt(log.blockNumber)), launchTime: timestamp, discoveredAt: now, blockHash: log.blockHash,
    transactionHash: log.transactionHash, logIndex: Number(BigInt(log.logIndex)) };
}
export function decodeTrade(log: RpcLog, token: string, quote: string, venueType: string, timestamp: number) {
  if (log.removed) throw new Error('Removed trade log');
  const d = decodeEventLog({ abi: venueType === 'curve' ? [curveBuy, curveSell] : [v3Swap], topics: log.topics as [Hex, ...Hex[]], data: log.data });
  const a = d.args as any;
  let side: 'buy' | 'sell'; let tokenAmount: bigint; let quoteAmount: bigint; let actor: string; let recipient: string | null;
  let attribution: string;
  if (d.eventName === 'CurveBuy') {
    side = 'buy'; tokenAmount = a.tokensOut; quoteAmount = a.quoteIn; actor = a.buyer; recipient = a.recipient; attribution = 'curve-recipient-address';
  } else if (d.eventName === 'CurveSell') {
    side = 'sell'; tokenAmount = a.tokensIn; quoteAmount = a.quoteOut; actor = a.seller; recipient = a.recipient; attribution = 'curve-quote-recipient';
  } else {
    const is0 = token.toLowerCase() < quote.toLowerCase();
    const quoteSigned: bigint = is0 ? a.amount1 : a.amount0;
    const tokenSigned: bigint = is0 ? a.amount0 : a.amount1;
    if (quoteSigned === 0n || tokenSigned === 0n || (quoteSigned > 0n) === (tokenSigned > 0n)) throw new Error('Unsupported swap amount direction');
    side = quoteSigned > 0n ? 'buy' : 'sell'; tokenAmount = tokenSigned < 0n ? -tokenSigned : tokenSigned;
    quoteAmount = quoteSigned < 0n ? -quoteSigned : quoteSigned; actor = a.sender; recipient = a.recipient;
    attribution = 'v3-recipient-may-be-router';
  }
  return { tokenAddress: token, venueAddress: log.address.toLowerCase(), transactionHash: log.transactionHash,
    logIndex: Number(BigInt(log.logIndex)), block: Number(BigInt(log.blockNumber)), blockHash: log.blockHash, timestamp,
    side, tokenAmount: tokenAmount.toString(), quoteAmount: quoteAmount.toString(), actor: actor.toLowerCase(),
    recipient: recipient?.toLowerCase() ?? null, attribution };
}
export function poolId(token: string, quote: string, fee: number, tickSpacing: number): string {
  const currencies = [token.toLowerCase(), quote.toLowerCase()].sort();
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
    [currencies[0] as Hex, currencies[1] as Hex, fee, tickSpacing, V2_HOOK]));
}
export function json(value: unknown): string { return JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v); }
