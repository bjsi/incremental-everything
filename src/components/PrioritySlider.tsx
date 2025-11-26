import React, { useCallback, useRef, useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import { percentileToHslColor } from '../lib/utils';

interface PrioritySliderProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  showValue?: boolean;
  disabled?: boolean;
  relativePriority?: number;
}

export interface PrioritySliderRef {
  focus: () => void;
  select: () => void;
}

export const PrioritySlider = forwardRef<PrioritySliderRef, PrioritySliderProps>(function PrioritySlider({
  value,
  onChange,
  min = 0,
  max = 100,
  showValue = true,
  disabled = false,
  relativePriority,
}, ref) {
  const trackRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [inputValue, setInputValue] = useState(value.toString());

  useEffect(() => {
    setInputValue(value.toString());
  }, [value]);

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
    select: () => inputRef.current?.select(),
  }));

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newInputValue = e.target.value;
    setInputValue(newInputValue);

    const parsed = parseInt(newInputValue, 10);
    if (!isNaN(parsed)) {
      const clamped = Math.max(min, Math.min(max, parsed));
      onChange(clamped);
    }
  };

  const handleInputBlur = () => {
    const parsed = parseInt(inputValue, 10);
    if (isNaN(parsed)) {
      setInputValue(value.toString());
    } else {
      const clamped = Math.max(min, Math.min(max, parsed));
      setInputValue(clamped.toString());
      onChange(clamped);
    }
  };

  const percentage = ((value - min) / (max - min)) * 100;
  // Use relative priority for color if provided, otherwise fall back to absolute position
  const colorValue = relativePriority !== undefined ? relativePriority : percentage;
  const thumbColor = percentileToHslColor(colorValue);

  const handleTrackClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (disabled || !trackRef.current) return;
      const rect = trackRef.current.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const newPercentage = Math.max(0, Math.min(100, (clickX / rect.width) * 100));
      const newValue = Math.round(min + (newPercentage / 100) * (max - min));
      onChange(newValue);
    },
    [disabled, min, max, onChange]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (disabled || !trackRef.current) return;
      e.preventDefault();

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!trackRef.current) return;
        const rect = trackRef.current.getBoundingClientRect();
        const moveX = moveEvent.clientX - rect.left;
        const newPercentage = Math.max(0, Math.min(100, (moveX / rect.width) * 100));
        const newValue = Math.round(min + (newPercentage / 100) * (max - min));
        onChange(newValue);
      };

      const handleMouseUp = () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [disabled, min, max, onChange]
  );

  return (
    <div className="flex items-center gap-2 w-full">
      {showValue && (
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          value={inputValue}
          onChange={handleInputChange}
          onBlur={handleInputBlur}
          disabled={disabled}
          className="text-xs font-bold tabular-nums px-1.5 py-0.5 rounded shrink-0 border-0 outline-none"
          style={{
            backgroundColor: thumbColor,
            color: 'white',
            width: '40px',
            textAlign: 'center',
          }}
        />
      )}
      <div
        ref={trackRef}
        className="relative flex-1 h-6 rounded-md cursor-pointer select-none"
        style={{
          background: `linear-gradient(to right,
            hsl(0, 80%, 50%),
            hsl(30, 80%, 50%),
            hsl(60, 80%, 50%),
            hsl(120, 60%, 45%),
            hsl(200, 70%, 50%),
            hsl(240, 70%, 55%)
          )`,
          opacity: disabled ? 0.5 : 1,
        }}
        onClick={handleTrackClick}
        onMouseDown={handleMouseDown}
      >
        {/* Track overlay for better visibility */}
        <div
          className="absolute inset-0 rounded-md"
          style={{
            background: 'linear-gradient(to bottom, rgba(255,255,255,0.2) 0%, transparent 50%, rgba(0,0,0,0.1) 100%)',
            pointerEvents: 'none',
          }}
        />

        {/* Thumb indicator */}
        <div
          className="absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full border-2 border-white shadow-md transition-shadow"
          style={{
            left: `calc(${percentage}% - 8px)`,
            backgroundColor: thumbColor,
            boxShadow: '0 2px 4px rgba(0,0,0,0.3), inset 0 1px 2px rgba(255,255,255,0.3)',
          }}
        />

        {/* Value markers */}
        <div className="absolute inset-x-0 bottom-0 flex justify-between px-1 text-white text-[8px] font-medium opacity-60" style={{ pointerEvents: 'none' }}>
          <span>0</span>
          <span>25</span>
          <span>50</span>
          <span>75</span>
          <span>100</span>
        </div>
      </div>
    </div>
  );
});
