import type { Config } from 'tailwindcss';

// Design tokens — Poolmigo brand kit v1.0. Values live in CSS variables (src/index.css)
// so light and dark share one set of utility names.
const v = (name: string) => `rgb(var(--c-${name}) / <alpha-value>)`;

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      white: '#FFFFFF',
      black: '#000000',
      deep: v('deep'),
      panel: v('panel'),
      'panel-2': v('panel-2'),
      line: v('line'),
      'line-2': v('line-2'),
      ink: v('ink'),
      'ink-2': v('ink-2'),
      'ink-3': v('ink-3'),
      aqua: v('aqua'),
      'aqua-dim': v('aqua-dim'),
      up: v('up'),
      down: v('down'),
      amber: v('amber'),
      apricot: v('apricot'),
      glass: v('glass'),
      tide: v('tide'),
      'on-primary': v('on-primary'),
      'on-accent': v('on-accent'),
    },
    fontFamily: {
      display: ['Rubik', 'Arial', 'system-ui', 'sans-serif'],
      sans: ['Rubik', 'Arial', 'system-ui', 'sans-serif'],
      mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
    },
    extend: {
      borderRadius: { DEFAULT: '8px', md: '12px', lg: '16px' },
      fontSize: {
        '2xs': ['11px', '14px'],
        xs: ['12px', '16px'],
        sm: ['13px', '18px'],
        base: ['14px', '20px'],
        md: ['15px', '22px'],
        lg: ['17px', '24px'],
        xl: ['20px', '26px'],
        '2xl': ['24px', '30px'],
        '3xl': ['30px', '36px'],
        '4xl': ['38px', '44px'],
      },
      boxShadow: { pop: '0 8px 24px rgb(var(--c-shadow) / 0.14), 0 0 0 1px rgb(var(--c-line))' },
      keyframes: {
        'fade-in': { from: { opacity: '0', transform: 'translateY(4px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        spin: { to: { transform: 'rotate(360deg)' } },
      },
      animation: { 'fade-in': 'fade-in 160ms ease-out', spin: 'spin 800ms linear infinite' },
    },
  },
  plugins: [],
} satisfies Config;
