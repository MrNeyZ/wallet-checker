type Props = {
  address: string;
  className?: string;
  chars?: number;
  explorer?: 'solscan' | 'solanafm' | 'xray';
};

export function shortenAddress(addr: string, chars = 4): string {
  if (addr.length <= chars * 2 + 3) return addr;
  return `${addr.slice(0, chars)}...${addr.slice(-chars)}`;
}

const explorerBase: Record<NonNullable<Props['explorer']>, string> = {
  solscan: 'https://solscan.io/account/',
  solanafm: 'https://solana.fm/address/',
  xray: 'https://xray.helius.xyz/account/',
};

export function WalletLink({
  address,
  className = '',
  chars = 4,
  explorer = 'solscan',
}: Props) {
  return (
    <a
      href={`${explorerBase[explorer]}${address}`}
      target="_blank"
      rel="noopener noreferrer"
      className={`font-mono text-sm text-neutral-300 hover:text-white transition-colors ${className}`}
    >
      {shortenAddress(address, chars)}
    </a>
  );
}
