export type ChainId = 'ethereum' | 'robinhood' | 'arc';

export interface Chain {
  id: ChainId;
  name: string;
  color: string;
  isNew?: boolean;
}

/** First-wave supported chains. */
export const CHAINS: Record<ChainId, Chain> = {
  ethereum: { id: 'ethereum', name: 'Ethereum', color: '#3B3D4A' },
  robinhood: { id: 'robinhood', name: 'Robinhood Chain', color: '#CCFF00', isNew: true },
  arc: { id: 'arc', name: 'Arc', color: '#1C2A5A', isNew: true },
};
