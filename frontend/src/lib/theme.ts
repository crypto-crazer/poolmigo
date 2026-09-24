import { useStore } from '@/store/useStore';

export type Theme = 'light' | 'dark';

export interface Palette {
  ink: string; ink2: string; ink3: string; line: string; grid: string; panel: string; panel2: string;
  aqua: string; up: string; down: string; amber: string; apricot: string; glass: string;
}

const LIGHT: Palette = {
  ink: '#302823', ink2: '#625D57', ink3: '#8F8981', line: '#DDD9D1', grid: '#F1ECE3', panel: '#FFFFFF', panel2: '#F6EFE4',
  aqua: '#244742', up: '#28614F', down: '#A33832', amber: '#8B5A13', apricot: '#F3A66E', glass: '#7BB8B2',
};
const DARK: Palette = {
  ink: '#F4EEE5', ink2: '#C3B9AD', ink3: '#8F8981', line: '#3B332C', grid: '#2D2621', panel: '#231E1A', panel2: '#2D2621',
  aqua: '#7BB8B2', up: '#74C69D', down: '#E8857D', amber: '#E3A94E', apricot: '#F3A66E', glass: '#7BB8B2',
};

/** Hex palette for chart libraries that can't read CSS variables. */
export function usePalette(): Palette {
  const theme = useStore((s) => s.theme);
  return theme === 'dark' ? DARK : LIGHT;
}
