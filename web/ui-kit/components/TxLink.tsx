import { shortenAddress } from './WalletLink';

type Props = {
  signature: string;
  className?: string;
  chars?: number;
  explorer?: 'solscan' | 'solanafm' | 'xray';
};

const explorerBase: Record<NonNullable<Props['explorer']>, string> = {
  solscan: 'https://solscan.io/tx/',
  solanafm: 'https://solana.fm/tx/',
  xray: 'https://xray.helius.xyz/tx/',
};

export function TxLink({
  signature,
  className = '',
  chars = 6,
  explorer = 'solscan',
}: Props) {
  return (
    <a
      href={`${explorerBase[explorer]}${signature}`}
      target="_blank"
      rel="noopener noreferrer"
      className={`font-mono text-xs text-neutral-400 hover:text-white transition-colors ${className}`}
    >
      {shortenAddress(signature, chars)}
    </a>
  );
}
