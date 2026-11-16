'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';

const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
const months = Array.from({ length: 12 }, (_, i) => `${i + 1}月`);

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function buildMonthCells(year: number, monthIndex: number) {
  const firstDay = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
  const offset = (firstDay + 6) % 7; // Monday = 0
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const cells: (string | null)[] = Array(offset).fill(null);
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(`${year}-${pad2(monthIndex + 1)}-${pad2(d)}`);
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export function DatePickerButton({
  prefix,
  ariaLabel,
  value,
  onChange,
  today,
  years,
  rangeStart,
  rangeEnd,
}: {
  prefix: string;
  ariaLabel: string;
  value: string;
  onChange: (next: string) => void;
  today: string;
  years: number[];
  rangeStart?: string;
  rangeEnd?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const initialYm = value || today;
  const [viewYear, setViewYear] = useState(() => Number(initialYm.slice(0, 4)));
  const [viewMonth, setViewMonth] = useState(() => Number(initialYm.slice(5, 7)) - 1);

  useEffect(() => {
    if (!open) return;
    const base = value || today;
    setViewYear(Number(base.slice(0, 4)));
    setViewMonth(Number(base.slice(5, 7)) - 1);
  }, [open, value, today]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const cells = useMemo(() => buildMonthCells(viewYear, viewMonth), [viewYear, viewMonth]);
  const yearOptions = useMemo(() => {
    const set = new Set<number>([...years, viewYear, Number(today.slice(0, 4))]);
    return [...set].sort((a, b) => b - a);
  }, [years, viewYear, today]);

  function stepMonth(delta: number) {
    const d = new Date(Date.UTC(viewYear, viewMonth + delta, 1));
    setViewYear(d.getUTCFullYear());
    setViewMonth(d.getUTCMonth());
  }

  return (
    <div className="date-picker-wrap" ref={rootRef}>
      <button
        type="button"
        className={`date-picker-trigger ${value ? 'has-value' : ''} ${open ? 'is-open' : ''}`}
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
      >
        <span className="date-picker-prefix">{prefix}</span>
        <span className="date-picker-val">{value || '选择日期'}</span>
        <CalendarDays size={13} className="date-picker-icon" />
      </button>
      {value && (
        <button
          type="button"
          className="date-picker-clear"
          aria-label={`清除${ariaLabel}`}
          onClick={e => {
            e.stopPropagation();
            onChange('');
          }}
        >
          <X size={12} />
        </button>
      )}
      {open && (
        <div className="date-popover" role="dialog" aria-label={ariaLabel}>
          <div className="date-popover-head">
            <button type="button" className="date-nav-btn" aria-label="上个月" onClick={() => stepMonth(-1)}>
              <ChevronLeft size={14} />
            </button>
            <div className="date-popover-selects">
              <select aria-label="选择年份" value={viewYear} onChange={e => setViewYear(Number(e.target.value))}>
                {yearOptions.map(y => (
                  <option key={y} value={y}>
                    {y}年
                  </option>
                ))}
              </select>
              <select aria-label="选择月份" value={viewMonth} onChange={e => setViewMonth(Number(e.target.value))}>
                {months.map((m, idx) => (
                  <option key={m} value={idx}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <button type="button" className="date-nav-btn" aria-label="下个月" onClick={() => stepMonth(1)}>
              <ChevronRight size={14} />
            </button>
          </div>
          <div className="date-popover-weekdays">
            {weekdays.map(w => (
              <span key={w}>{w}</span>
            ))}
          </div>
          <div className="date-popover-grid">
            {cells.map((iso, i) => {
              if (!iso) return <span key={`empty-${i}`} className="date-cell-blank" />;
              const isSelected = iso === value;
              const isToday = iso === today;
              const inRange = !!(rangeStart && rangeEnd && iso > rangeStart && iso < rangeEnd);
              const isRangeEdge = (!!rangeStart && iso === rangeStart) || (!!rangeEnd && iso === rangeEnd);
              return (
                <button
                  key={iso}
                  type="button"
                  className={`date-cell ${isSelected || isRangeEdge ? 'is-selected' : ''} ${inRange ? 'in-range' : ''} ${isToday ? 'is-today' : ''}`}
                  onClick={() => {
                    onChange(iso);
                    setOpen(false);
                  }}
                >
                  {Number(iso.slice(8, 10))}
                </button>
              );
            })}
          </div>
          <div className="date-popover-foot">
            <button
              type="button"
              className="date-foot-btn"
              onClick={() => {
                onChange(today);
                setOpen(false);
              }}
            >
              今天
            </button>
            <button
              type="button"
              className="date-foot-btn is-muted"
              onClick={() => {
                onChange('');
                setOpen(false);
              }}
            >
              清除
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
