import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatPercent(value: number | undefined | null): string {
  if (typeof value !== 'number') return '0.0000%';
  return (value * 100).toFixed(4) + '%';
}

export function formatUsd(value: number | undefined | null): string {
  if (typeof value !== 'number') return '$0.00';
  return '$' + value.toFixed(2);
}

export function formatUptime(seconds: number | undefined | null): string {
  if (typeof seconds !== 'number') return '00:00:00';
  const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}
