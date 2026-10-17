import { useEffect, useState } from 'react';

export type Appearance = { theme: 'dark' | 'light'; fontSize: number };
const key = 'dockslate.appearance';
export const defaultAppearance: Appearance = { theme: 'dark', fontSize: 12 };

export function readAppearance(): Appearance {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null');
    return {
      theme: value?.theme === 'light' ? 'light' : 'dark',
      fontSize: Number.isInteger(value?.fontSize) && value.fontSize >= 11 && value.fontSize <= 16 ? value.fontSize : defaultAppearance.fontSize,
    };
  } catch { return { ...defaultAppearance }; }
}

export function applyAppearance(value: Appearance) {
  document.documentElement.dataset.theme = value.theme;
  document.documentElement.style.setProperty('--ui-font-size', `${value.fontSize}px`);
}

export function useAppearance() {
  const [appearance, setAppearance] = useState(readAppearance);
  useEffect(() => {
    applyAppearance(appearance);
    try { localStorage.setItem(key, JSON.stringify(appearance)); } catch { /* 저장소 사용 불가 */ }
  }, [appearance]);
  return { appearance, setAppearance };
}
