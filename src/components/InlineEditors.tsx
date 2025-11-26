import React from 'react';

interface InlinePriorityEditorProps {
  value: number;
  onChange: (value: number) => void;
  onSave: () => void;
  onCancel: () => void;
}

export function InlinePriorityEditor({ value, onChange, onSave, onCancel }: InlinePriorityEditorProps) {
  return (
    <div className="flex items-center gap-2 mb-2 p-2 rounded" style={{ backgroundColor: 'var(--rn-clr-background-primary)', border: '1px solid var(--rn-clr-border-primary)' }}>
      <span className="text-xs" style={{ color: 'var(--rn-clr-content-secondary)' }}>Priority:</span>
      <input
        type="number"
        min={0}
        max={100}
        value={value}
        onChange={(e) => onChange(Math.min(100, Math.max(0, parseInt(e.target.value) || 0)))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); onSave(); }
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }}
        className="w-14 text-xs p-1 rounded text-center"
        style={{ border: '1px solid var(--rn-clr-border-primary)', backgroundColor: 'var(--rn-clr-background-secondary)', color: 'var(--rn-clr-content-primary)' }}
        autoFocus
      />
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value))}
        className="flex-1"
        style={{ accentColor: '#8b5cf6' }}
      />
      <button onClick={onSave} className="px-2 py-1 text-xs rounded" style={{ backgroundColor: '#8b5cf6', color: 'white' }}>Save</button>
    </div>
  );
}

interface InlinePageRangeEditorProps {
  startValue: number;
  endValue: number;
  onStartChange: (value: number) => void;
  onEndChange: (value: number) => void;
  onSave: () => void;
  onCancel: () => void;
  startInputRef?: React.RefCallback<HTMLInputElement>;
  endInputRef?: React.RefCallback<HTMLInputElement>;
}

export function InlinePageRangeEditor({
  startValue,
  endValue,
  onStartChange,
  onEndChange,
  onSave,
  onCancel,
  startInputRef,
  endInputRef,
}: InlinePageRangeEditorProps) {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); onSave(); }
    if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
  };

  return (
    <div className="flex items-center gap-2 mb-2 p-2 rounded" style={{ backgroundColor: 'var(--rn-clr-background-primary)', border: '1px solid var(--rn-clr-border-primary)' }}>
      <span className="text-xs" style={{ color: 'var(--rn-clr-content-secondary)' }}>Pages:</span>
      <input
        ref={startInputRef}
        type="number"
        min="1"
        value={startValue}
        onChange={(e) => onStartChange(parseInt(e.target.value) || 1)}
        onKeyDown={handleKeyDown}
        className="w-14 text-xs p-1 rounded text-center"
        style={{ border: '1px solid var(--rn-clr-border-primary)', backgroundColor: 'var(--rn-clr-background-secondary)', color: 'var(--rn-clr-content-primary)' }}
      />
      <span className="text-xs" style={{ color: 'var(--rn-clr-content-tertiary)' }}>to</span>
      <input
        ref={endInputRef}
        type="number"
        min={startValue}
        value={endValue || ''}
        onChange={(e) => onEndChange(parseInt(e.target.value) || 0)}
        onKeyDown={handleKeyDown}
        className="w-14 text-xs p-1 rounded text-center"
        style={{ border: '1px solid var(--rn-clr-border-primary)', backgroundColor: 'var(--rn-clr-background-secondary)', color: 'var(--rn-clr-content-primary)' }}
        placeholder="∞"
      />
      <button onClick={onSave} className="px-2 py-1 text-xs rounded" style={{ backgroundColor: '#3b82f6', color: 'white' }}>Save</button>
    </div>
  );
}

interface InlineHistoryEditorProps {
  value: number;
  onChange: (value: number) => void;
  onSave: () => void;
  onCancel: () => void;
}

export function InlineHistoryEditor({ value, onChange, onSave, onCancel }: InlineHistoryEditorProps) {
  return (
    <div className="flex items-center gap-2 mb-2 p-2 rounded" style={{ backgroundColor: 'var(--rn-clr-background-primary)', border: '1px solid var(--rn-clr-border-primary)' }}>
      <span className="text-xs" style={{ color: 'var(--rn-clr-content-secondary)' }}>Page:</span>
      <input
        type="number"
        min={1}
        value={value || ''}
        onChange={(e) => onChange(parseInt(e.target.value) || 0)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); onSave(); }
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }}
        className="w-14 text-xs p-1 rounded text-center"
        style={{ border: '1px solid var(--rn-clr-border-primary)', backgroundColor: 'var(--rn-clr-background-secondary)', color: 'var(--rn-clr-content-primary)' }}
        autoFocus
      />
      <button onClick={onSave} className="px-2 py-1 text-xs rounded" style={{ backgroundColor: '#10b981', color: 'white' }}>Save</button>
    </div>
  );
}
