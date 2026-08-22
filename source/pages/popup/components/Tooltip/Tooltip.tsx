import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import styles from './Tooltip.module.scss';

interface TooltipState {
  text: string;
  x: number;
  y: number;
  // Horizontal offset of the arrow relative to the tooltip center,
  // so the arrow keeps pointing at the trigger after viewport clamping.
  arrowOffset: number;
}

interface TooltipProviderProps {
  children: ReactNode;
}

// TooltipProvider
export default function TooltipProvider({
  children,
}: TooltipProviderProps): ReactNode {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const show = (target: HTMLElement): void => {
      const text = target.dataset.tooltip;
      if (!text) {
        return;
      }
      const rect = target.getBoundingClientRect();
      const triggerX = rect.left + rect.width / 2;
      const y = rect.top - 6;
      // Initial position centered on the trigger; arrow offset is 0.
      setTooltip({ text, x: triggerX, y, arrowOffset: 0 });
    };

    const onOver = (e: MouseEvent): void => {
      const target = (e.target as HTMLElement)?.closest<HTMLElement>(
        '[data-tooltip]'
      );
      if (target) {
        show(target);
      }
    };

    const onOut = (e: MouseEvent): void => {
      const related = e.relatedTarget as HTMLElement | null;
      if (!related || !related.closest('[data-tooltip]')) {
        setTooltip(null);
      }
    };

    document.addEventListener('mouseover', onOver);
    document.addEventListener('mouseout', onOut);
    return (): void => {
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('mouseout', onOut);
    };
  }, []);

  // After render, measure actual width and clamp within the viewport.
  useLayoutEffect(() => {
    if (!tooltip) {
      return;
    }
    const el = tooltipRef.current;
    if (!el) {
      return;
    }
    const half = el.offsetWidth / 2;
    const margin = 8;
    const maxRight = window.innerWidth - margin;
    const minLeft = margin;
    let x = tooltip.x;
    if (x + half > maxRight) {
      x = maxRight - half;
    } else if (x - half < minLeft) {
      x = minLeft + half;
    }
    // Arrow points back at the trigger center.
    const triggerX = tooltip.x + tooltip.arrowOffset;
    const arrowOffset = triggerX - x;
    if (x !== tooltip.x || arrowOffset !== tooltip.arrowOffset) {
      setTooltip((prev) => (prev ? { ...prev, x, arrowOffset } : prev));
    }
  }, [tooltip]);

  return (
    <>
      {children}
      {tooltip && (
        <div
          ref={tooltipRef}
          className={styles.tooltip}
          style={
            {
              left: tooltip.x,
              top: tooltip.y,
              '--arrow-offset': `${tooltip.arrowOffset}px`,
            } as React.CSSProperties
          }
          role="tooltip"
        >
          {tooltip.text}
        </div>
      )}
    </>
  );
}
