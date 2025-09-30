import {
  renderWidget,
  usePlugin,
  useTracker,
} from '@remnote/plugin-sdk';
import React, { useEffect, useState } from 'react';
import { noIncRemTimerKey } from '../lib/consts';

function NoIncTimerIndicator() {
  const plugin = usePlugin();
  const [currentTime, setCurrentTime] = useState(Date.now());
  
  // Use synced storage instead of session storage
  const noIncRemTimerEnd = useTracker(
    async (rp) => {
      const value = await rp.storage.getSynced<number>(noIncRemTimerKey);
      console.log('NoIncTimerIndicator: Timer end value:', value);
      return value;
    },
    []
  );

  // Update current time every second to show countdown
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 1000);
    
    return () => clearInterval(interval);
  }, []);

  const isTimerActive = noIncRemTimerEnd && noIncRemTimerEnd > currentTime;
  const timeRemainingMs = isTimerActive ? noIncRemTimerEnd - currentTime : 0;
  const minutes = Math.floor(timeRemainingMs / 60000);
  const seconds = Math.floor((timeRemainingMs % 60000) / 1000);

  // Auto-cleanup expired timer
  useEffect(() => {
    if (noIncRemTimerEnd && noIncRemTimerEnd <= currentTime) {
      console.log('NoIncTimerIndicator: Timer expired, clearing...');
      plugin.storage.setSynced(noIncRemTimerKey, null);
    }
  }, [noIncRemTimerEnd, currentTime, plugin]);

  console.log('NoIncTimerIndicator: Rendering, isTimerActive:', isTimerActive);

  if (!isTimerActive) {
    return null;
  }

  return (
    <div 
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 12px',
        backgroundColor: '#fef3c7',
        borderRadius: '6px',
        border: '1px solid #f59e0b',
        boxShadow: '0 1px 2px rgba(0, 0, 0, 0.05)',
        minWidth: 170,
      }}
    >
      <span style={{ fontSize: '14px' }}>⏱️</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <div style={{ 
          fontSize: '12px', 
          fontWeight: 600, 
          color: '#92400e' 
        }}>
          No Inc Rem Mode
        </div>
        <div style={{ 
          fontSize: '11px', 
          color: '#78350f',
          fontVariantNumeric: 'tabular-nums' 
        }}>
          {minutes}:{seconds.toString().padStart(2, '0')} remaining
        </div>
      </div>
      <button
        onClick={async () => {
          await plugin.storage.setSynced(noIncRemTimerKey, null);
          await plugin.app.toast('Incremental rems re-enabled');
          // Force queue refresh
          await plugin.storage.setSynced('queue-refresh-trigger', Date.now());
        }}
        style={{
          padding: '4px 8px',
          fontSize: '11px',
          backgroundColor: '#dc2626',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          cursor: 'pointer',
          fontWeight: 500,
          marginLeft: '8px'
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = '#b91c1c';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = '#dc2626';
        }}
      >
         ✕
      </button>
    </div>
  );
}

renderWidget(NoIncTimerIndicator);