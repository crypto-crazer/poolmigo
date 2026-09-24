import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { bytes32Label, formatAmount, formatAmountSignificant, parseAmount, shortHex, toExactString } from '@/chain/amounts';
import {
  DEFAULT_SLIPPAGE_BPS,
  dispatchBasket,
  insufficientBalance,
  minSharesFromPreview,
  parseSlippageBps,
  tokensNeedingApproval,
} from '@/chain/deposit';

const USDG = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as Address; // 6 decimals
const WETH = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512' as Address; // 18 decimals

describe('parseAmount — mixed decimals', () => {
  it('parses 6-decimal input', () => {
    expect(parseAmount('1000', 6)).toEqual({ ok: true, value: 1_000_000_000n });
    expect(parseAmount('0.5', 6)).toEqual({ ok: true, value: 500_000n });
    expect(parseAmount('0.000001', 6)).toEqual({ ok: true, value: 1n });
    expect(parseAmount('.5', 6)).toEqual({ ok: true, value: 500_000n });
    expect(parseAmount('1,000.25', 6)).toEqual({ ok: true, value: 1_000_250_000n });
  });

  it('parses 18-decimal input without float error', () => {
    expect(parseAmount('1', 18)).toEqual({ ok: true, value: 10n ** 18n });
    expect(parseAmount('0.1', 18)).toEqual({ ok: true, value: 100_000_000_000_000_000n });
    // 0.1 + 0.2 in floats is 0.30000000000000004; as base units it is exact.
    expect(parseAmount('0.3', 18).ok && parseAmount('0.3', 18)).toEqual({ ok: true, value: 300_000_000_000_000_000n });
    expect(parseAmount('123456789.123456789123456789', 18)).toEqual({
      ok: true,
      value: 123_456_789_123_456_789_123_456_789n,
    });
  });

  it('rejects more precision than the token has', () => {
    expect(parseAmount('0.1234567', 6)).toEqual({ ok: false, error: 'Max 6 decimals' });
    expect(parseAmount('0.1234567', 18).ok).toBe(true);
  });

  it('rejects junk and blanks', () => {
    expect(parseAmount('', 6).ok).toBe(false);
    expect(parseAmount('   ', 6).ok).toBe(false);
    expect(parseAmount('.', 6).ok).toBe(false);
    expect(parseAmount('abc', 6)).toEqual({ ok: false, error: 'Numbers only' });
    expect(parseAmount('-1', 6)).toEqual({ ok: false, error: 'Numbers only' });
    expect(parseAmount('1e6', 6)).toEqual({ ok: false, error: 'Numbers only' });
  });

  it('accepts a literal zero', () => {
    expect(parseAmount('0', 18)).toEqual({ ok: true, value: 0n });
  });
});

describe('formatAmount — display', () => {
  it('groups and truncates rather than rounding up', () => {
    expect(formatAmount(1_234_567_891n, 6, 4)).toBe('1,234.5678'); // 1234.567891 → 1234.5678
    expect(formatAmount(999_999n, 6, 2)).toBe('0.99');
    expect(formatAmount(10n ** 18n, 18, 4)).toBe('1');
    expect(formatAmount(1_500_000_000_000_000_000n, 18, 4)).toBe('1.5');
  });

  it('never prints a non-zero amount as 0', () => {
    expect(formatAmount(1n, 18, 4)).toBe('<0.0001');
    expect(formatAmount(1n, 6, 2)).toBe('<0.01');
    expect(formatAmount(0n, 6, 4)).toBe('0');
  });

  it('handles negatives and zero-decimal tokens', () => {
    expect(formatAmount(-1_500_000n, 6, 4)).toBe('-1.5');
    expect(formatAmount(42n, 0, 4)).toBe('42');
  });

  it('round-trips through toExactString', () => {
    for (const [value, decimals] of [
      [1_234_567_891n, 6],
      [10n ** 18n, 18],
      [1n, 18],
      [0n, 6],
    ] as const) {
      const parsed = parseAmount(toExactString(value, decimals), decimals);
      expect(parsed.ok && parsed.value).toBe(value);
    }
  });
});

describe('formatAmountSignificant — migoLP lives at 1e-7', () => {
  it('keeps 6 significant digits however small the amount is', () => {
    // Bootstrap set shares = amounts_[0] of a 6-decimal token, so supply ≈ 1e11 wei of an 18dp token.
    expect(formatAmountSignificant(100_000_000_000n, 18)).toBe('0.0000001');
    expect(formatAmountSignificant(123_456_789_012n, 18)).toBe('0.000000123456');
    expect(formatAmount(100_000_000_000n, 18, 4)).toBe('<0.0001'); // what the fixed format would show
  });

  it('falls back to 4 decimals once the amount is ≥ 1', () => {
    expect(formatAmountSignificant(1_500_000_000_000_000_000n, 18)).toBe('1.5');
    expect(formatAmountSignificant(0n, 18)).toBe('0');
  });
});

describe('bytes32 + hex labels', () => {
  it('decodes packed ascii adapter labels', () => {
    // bytes32("uniswap-v3")
    const dex = '0x756e69737761702d763300000000000000000000000000000000000000000000';
    expect(bytes32Label(dex)).toBe('uniswap-v3');
  });
  it('falls back to short hex for non-ascii or malformed input', () => {
    expect(bytes32Label('0xff'.padEnd(66, '0'))).toMatch(/^0xff/);
    expect(bytes32Label(undefined)).toBe('—');
  });
  it('shortens addresses', () => {
    expect(shortHex(USDG)).toBe('0x5FbD…0aa3');
  });
});

describe('minShares — the depositor’s only protection', () => {
  it('applies the tolerance as a floor', () => {
    expect(minSharesFromPreview(1_000_000n, DEFAULT_SLIPPAGE_BPS)).toBe(995_000n); // 0.50%
    expect(minSharesFromPreview(1_000_000n, 0)).toBe(1_000_000n);
    expect(minSharesFromPreview(1_000_000n, 100)).toBe(990_000n);
    expect(minSharesFromPreview(3n, 5_000)).toBe(1n); // floor(1.5)
  });

  it('is never zero while shares are positive — the contract reverts on minShares == 0', () => {
    expect(minSharesFromPreview(1n, DEFAULT_SLIPPAGE_BPS)).toBe(1n);
    expect(minSharesFromPreview(1n, 10_000)).toBe(1n);
  });

  it('is zero only when there is nothing to mint', () => {
    expect(minSharesFromPreview(0n, DEFAULT_SLIPPAGE_BPS)).toBe(0n);
  });

  it('clamps a nonsense tolerance instead of inverting the maths', () => {
    expect(minSharesFromPreview(1_000_000n, -50)).toBe(1_000_000n);
    expect(minSharesFromPreview(1_000_000n, 99_999)).toBe(1n);
  });
});

describe('parseSlippageBps', () => {
  it('converts percent to bps', () => {
    expect(parseSlippageBps('0.5')).toEqual({ ok: true, bps: 50 });
    expect(parseSlippageBps('1')).toEqual({ ok: true, bps: 100 });
    expect(parseSlippageBps('0')).toEqual({ ok: true, bps: 0 });
  });
  it('rejects junk and absurd values', () => {
    expect(parseSlippageBps('').ok).toBe(false);
    expect(parseSlippageBps('abc').ok).toBe(false);
    expect(parseSlippageBps('-1').ok).toBe(false);
    expect(parseSlippageBps('80')).toEqual({ ok: false, error: 'Max 50%' });
  });
});

describe('dispatchBasket — per-token fields → aligned (tokens[], amounts[])', () => {
  const base = [
    { token: USDG, decimals: 6, total: 100_000_000_000n },
    { token: WETH, decimals: 18, total: 10n * 10n ** 18n },
  ];

  it('keeps registry order and offers the whole basket', () => {
    const offer = dispatchBasket([
      { ...base[0], input: '1000' },
      { ...base[1], input: '0.1' },
    ]);
    expect(offer.tokens).toEqual([USDG, WETH]);
    expect(offer.amounts).toEqual([1_000_000_000n, 100_000_000_000_000_000n]);
    expect(offer.ready).toBe(true);
    expect(offer.hasMissingAmount).toBe(false);
  });

  it('flags a held token left empty — previewDeposit would revert with ZeroShares', () => {
    const offer = dispatchBasket([
      { ...base[0], input: '1000' },
      { ...base[1], input: '' },
    ]);
    expect(offer.hasMissingAmount).toBe(true);
    expect(offer.ready).toBe(false);
    expect(offer.amounts[1]).toBe(0n);
  });

  it('treats an explicit zero the same as an empty field', () => {
    const offer = dispatchBasket([
      { ...base[0], input: '1000' },
      { ...base[1], input: '0' },
    ]);
    expect(offer.hasMissingAmount).toBe(true);
  });

  it('does not demand an amount for a token the vault does not hold', () => {
    const offer = dispatchBasket([
      { ...base[0], input: '1000' },
      { token: WETH, decimals: 18, total: 0n, input: '' },
    ]);
    expect(offer.hasMissingAmount).toBe(false);
    expect(offer.ready).toBe(true);
  });

  it('surfaces per-token parse errors without dropping the token', () => {
    const offer = dispatchBasket([
      { ...base[0], input: '0.1234567' },
      { ...base[1], input: '1' },
    ]);
    expect(offer.errors[USDG]).toBe('Max 6 decimals');
    expect(offer.tokens).toHaveLength(2);
    expect(offer.ready).toBe(false);
  });
});

describe('approval + balance checks', () => {
  const tokens = [USDG, WETH];
  const required = [1_000_000_000n, 100_000_000_000_000_000n];

  it('asks for approval only where the allowance is short', () => {
    expect(tokensNeedingApproval(tokens, required, [0n, required[1]])).toEqual([USDG]);
    expect(tokensNeedingApproval(tokens, required, required)).toEqual([]);
    expect(tokensNeedingApproval(tokens, required, [required[0] - 1n, 0n])).toEqual([USDG, WETH]);
  });

  it('ignores tokens the vault will not pull', () => {
    expect(tokensNeedingApproval(tokens, [0n, required[1]], [0n, required[1]])).toEqual([]);
  });

  it('reports the first token the wallet cannot cover', () => {
    expect(insufficientBalance(tokens, required, [required[0], required[1]])).toBeNull();
    expect(insufficientBalance(tokens, required, [required[0] - 1n, required[1]])).toBe(USDG);
    expect(insufficientBalance(tokens, required, [required[0], 0n])).toBe(WETH);
  });
});
