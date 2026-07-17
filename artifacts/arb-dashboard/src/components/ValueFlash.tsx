import { useEffect, useState, useRef } from 'react';
import { cn } from '@/lib/utils';

interface ValueFlashProps {
  value: string | number;
  className?: string;
  type?: 'number' | 'text';
}

export function ValueFlash({ value, className, type = 'number' }: ValueFlashProps) {
  const [flash, setFlash] = useState<'up' | 'down' | 'neutral' | null>(null);
  const prevValue = useRef(value);

  useEffect(() => {
    if (prevValue.current === value) return;

    if (type === 'number') {
      const currentNum = typeof value === 'string' ? parseFloat(value.replace(/[^0-9.-]/g, '')) : value;
      const prevNum = typeof prevValue.current === 'string' ? parseFloat(prevValue.current.replace(/[^0-9.-]/g, '')) : prevValue.current;

      if (!isNaN(currentNum) && !isNaN(prevNum)) {
        if (currentNum > prevNum) setFlash('up');
        else if (currentNum < prevNum) setFlash('down');
        else setFlash('neutral');
      } else {
        setFlash('neutral');
      }
    } else {
      setFlash('neutral');
    }

    prevValue.current = value;
    const t = setTimeout(() => setFlash(null), 500);
    return () => clearTimeout(t);
  }, [value, type]);

  return (
    <span
      className={cn(
        "transition-colors duration-500",
        flash === 'up' && "bg-green-500/30 text-green-300",
        flash === 'down' && "bg-red-500/30 text-red-300",
        flash === 'neutral' && "bg-primary/30 text-primary",
        !flash && "bg-transparent",
        className
      )}
    >
      {value}
    </span>
  );
}
