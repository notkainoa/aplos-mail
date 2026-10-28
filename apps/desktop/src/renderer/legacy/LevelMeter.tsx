import { useEffect, useRef } from 'react';

export function LevelMeter({ level, bars = 7 }: { level: () => number; bars?: number }) {
  const root = useRef<HTMLSpanElement>(null);
  const read = useRef(level);
  read.current = level;
  useEffect(() => {
    let frame = 0;
    let tick = 0;
    const history = Array<number>(bars).fill(0);
    const draw = () => {
      // Sample every few frames so the bars drift instead of flickering.
      if (tick++ % 4 === 0) {
        history.push(read.current());
        history.shift();
        const items = root.current?.children;
        if (items)
          for (let i = 0; i < items.length; i++)
            (items[i] as HTMLElement).style.transform = `scaleY(${0.3 + history[i] * 0.7})`;
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [bars]);
  return (
    <span ref={root} className="level-meter" aria-hidden="true">
      {Array.from({ length: bars }, (_, i) => (
        <i key={i} />
      ))}
    </span>
  );
}
