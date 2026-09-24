import { Button } from '@/components/ui/Button';
import { useConnectWallet } from '@/chain/useConnectWallet';

/** First-screen job: identify the product, state the benefit, offer a next step. Shown only before connecting. */
export function Welcome() {
  const { connectWallet, isPending } = useConnectWallet();
  return (
    <section className="bg-panel border border-line rounded-lg overflow-hidden">
      <div className="flex flex-col md:flex-row items-center gap-6 md:gap-10 px-6 md:px-10 py-6">
        <img src={`${import.meta.env.BASE_URL}brand/mascot-hero.png`} alt="" className="h-36 md:h-44 w-auto select-none order-last md:order-first shrink-0" draggable={false} />
        <div className="flex-1 text-center md:text-left">
          <h1 className="display text-3xl md:text-4xl text-ink leading-tight">Meet your liquidity sidekick.</h1>
          <p className="text-md text-ink-2 mt-2">Automated liquidity vaults for less manual LP management.</p>
          <div className="mt-5 flex flex-wrap items-center justify-center md:justify-start gap-3">
            <Button size="lg" onClick={connectWallet} loading={isPending}>Connect wallet</Button>
            <span className="text-xs text-ink-3">Deposit one asset. The vault rebalances and compounds for you.</span>
          </div>
        </div>
      </div>
    </section>
  );
}
