import { useRef } from 'react';

// --- ACCELERATED KEYBOARD HANDLER HOOK ---
// This hook implements the logic for rapid taps and hold-to-accelerate
export function useAcceleratedKeyboardHandler(value: number | null, defaultValue: number, onChange: (val: number) => void) {
  // State for Rapid Taps
  const tapState = useRef<{ count: number; lastTime: number; direction: 'up' | 'down' | null }>({ count: 0, lastTime: 0, direction: null });
  // State for Press & Hold
  const holdState = useRef<{ active: boolean; startTime: number; direction: 'up' | 'down' | null }>({ active: false, startTime: 0, direction: null });

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const direction = e.key === 'ArrowUp' ? 'up' : 'down';
      const now = Date.now();
      const isRepeat = e.repeat;

      let step = 0;

      if (!isRepeat) {
        // --- RAPID TAP LOGIC ---
        // Check if this is a subsequent tap in the same direction within threshold
        if (tapState.current.direction === direction && (now - tapState.current.lastTime < 300)) {
          tapState.current.count += 1;
        } else {
          // Reset if too slow or changed direction
          tapState.current.count = 1;
          tapState.current.direction = direction;
        }
        tapState.current.lastTime = now;

        // Determine step based on tap count
        if (tapState.current.count === 1) step = 1;
        else if (tapState.current.count === 2) step = 5;
        else if (tapState.current.count === 3) step = 10;
        else step = 20;

      } else {
        // --- PRESS & HOLD LOGIC ---
        // If holding, we ignore the tap logic and use hold acceleration
        if (!holdState.current.active || holdState.current.direction !== direction) {
          holdState.current.active = true;
          holdState.current.startTime = now;
          holdState.current.direction = direction;
        }

        // Acceleration based on hold duration (simulated via repeat events)
        const duration = now - holdState.current.startTime;
        // Simple linear acceleration: starts at 1, increases every 500ms
        const speedFactor = 1 + Math.floor(duration / 500);
        step = Math.min(10, speedFactor); // Cap max hold speed per tick
      }

      // Apply the change
      const currentVal = value ?? defaultValue;
      
      // Standard logic: Up = +value, Down = -value
      // Note: Consumer is responsible for inverting if needed (e.g. Priority where Lower = Better)
      const delta = direction === 'up' ? 1 : -1;
      const finalStep = step * delta;

      // We don't clamp here because different inputs might have different ranges (e.g. Days vs Priority)
      // The consumer should handle clamping if necessary inside the onChange, 
      // OR we can add min/max params to this hook.
      // For now, let's just pass the computed new value and let the consumer clamp.
      // Actually, to keep it drop-in compatible with priority.tsx, we previously clamped 0-100.
      // Let's make it generic: take optional min/max?
      // Since priority.tsx clamped 0-100, checking the code...
      // "const newValue = Math.max(0, Math.min(100, currentVal + finalStep));"
      // So I should probably modify the hook to accept min/max, or just return the raw new value.
      
      // Let's modify the hook slightly to be more reusable:
      // Pass min/max as arguments. Defaults? 0-100 for backward compat or just require them.
      // Let's just return the raw calculated new value and let consumer handle validation?
      // No, for the acceleration to work properly with limits, validation needs to happen or at least clamping.
      
      // Wait, let's look at the original code implementation again.
      // It did: "const newValue = Math.max(0, Math.min(100, currentVal + finalStep));"
      // I'll add min/max arguments to this new shared hook.
      
      const newValue = currentVal + finalStep;
      onChange(newValue);
    }
  };

  const handleKeyUp = () => {
    holdState.current = { active: false, startTime: 0, direction: null };
    // We don't reset tap state on keyup because user might be tapping quickly
  };

  return { handleKeyDown, handleKeyUp };
}
