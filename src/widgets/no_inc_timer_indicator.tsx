import {
  renderWidget,
  usePlugin,
  useTrackerPlugin,
} from '@remnote/plugin-sdk';
import { useEffect, useState } from 'react';
import { noIncRemTimerKey, incRemDisabledDeviceKey } from '../lib/consts';
import { formatCountdown } from '../lib/utils';

function NoIncTimerIndicator() {
  const plugin = usePlugin();
  const [currentTime, setCurrentTime] = useState(Date.now());
  const [mountTime] = useState(Date.now());
  
  // Use synced storage instead of session storage
  const noIncRemTimerEnd = useTrackerPlugin(
    async (rp) => {
      const value = await rp.storage.getSynced<number>(noIncRemTimerKey);
      return value;
    },
    []
  );

  const isDeviceDisabled = useTrackerPlugin(
    async (rp) => {
      const value = await rp.storage.getLocal<boolean>(incRemDisabledDeviceKey);
      return !!value;
    },
    []
  );

  // Update current time every second to show countdown and handle auto-hide
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 1000);
    
    return () => clearInterval(interval);
  }, []);

  const isTimerActive = noIncRemTimerEnd && noIncRemTimerEnd > currentTime;
  const timeRemainingMs = isTimerActive ? noIncRemTimerEnd - currentTime : 0;

  // Auto-cleanup expired timer
  useEffect(() => {
    if (noIncRemTimerEnd && noIncRemTimerEnd <= currentTime) {
      plugin.storage.setSynced(noIncRemTimerKey, null);
    }
  }, [noIncRemTimerEnd, currentTime, plugin]);

  // If timer is active, priority is given to the timer.
  if (isTimerActive) {
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
            {formatCountdown(timeRemainingMs)} remaining
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

  // If timer is NOT active, but device is disabled:
  // Show it ONLY if less than 10 seconds have passed since mount
  const hideAfterMs = 10000;
  const showDeviceToggle = isDeviceDisabled && (currentTime - mountTime < hideAfterMs);

  if (showDeviceToggle) {
    return (
      <div 
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '4px 8px',
          backgroundColor: '#fee2e2',
          borderRadius: '6px',
          border: '1px solid #ef4444',
          boxShadow: '0 1px 2px rgba(0, 0, 0, 0.05)',
        }}
      >
        <span style={{ fontSize: '14px' }}>🚫</span>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ 
            fontSize: '12px', 
            fontWeight: 600, 
            color: '#991b1b' 
          }}>
            Inc Rems disabled (Device)
          </div>
        </div>
        <button
          onClick={async () => {
            await plugin.storage.setLocal(incRemDisabledDeviceKey, false);
            await plugin.app.toast('✅ Incremental rems enabled on this device');
            await plugin.storage.setSynced('queue-refresh-trigger', Date.now());
          }}
          style={{
            padding: '4px 8px',
            fontSize: '11px',
            backgroundColor: '#059669',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontWeight: 500,
            marginLeft: '4px'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = '#047857';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = '#059669';
          }}
        >
           Enable
        </button>
      </div>
    );
  }

  return null;
}

renderWidget(NoIncTimerIndicator);