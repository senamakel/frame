interface Token {
  chainId: number,
  name: string,
  symbol: string,
  address: string,
  decimals: number,
  logoUri?: string
}

interface Chain {
  type: 'ethereum',
  id: number,
  name: string,
  nativeCurrency: string,
  rpcUrls: string[],
  blockExplorerUrls: string[], 
  iconUrls: string[]
}
