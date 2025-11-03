import { RNPlugin } from '@remnote/plugin-sdk';
import { alwaysUseLightModeOnMobileId, lastDetectedOSKey, isMobileDeviceKey } from './consts';

/**
 * Get the operating system name
 */
export async function getOperatingSystem(plugin: RNPlugin): Promise<string> {
  try {
    const os = await plugin.app.getOperatingSystem();
    return os;
  } catch (error) {
    console.error('Error detecting OS via SDK:', error);
    // Fallback to browser-based detection
    const userAgent = navigator.userAgent || navigator.vendor || (window as any).opera;
    if (/android/i.test(userAgent)) return 'android';
    if (/iPad|iPhone|iPod/.test(userAgent)) return 'ios';
    if (/Mac/.test(userAgent)) return 'mac';
    if (/Win/.test(userAgent)) return 'windows';
    if (/Linux/.test(userAgent)) return 'linux';
    return 'unknown';
  }
}

/**
 * Check if the current device is mobile
 */
export async function isMobileDevice(plugin: RNPlugin): Promise<boolean> {
  const os = await getOperatingSystem(plugin);
  return os === 'ios' || os === 'android';
}

/**
 * Get a user-friendly OS name
 */
export function getFriendlyOSName(os: string): string {
  const osNames: Record<string, string> = {
    'ios': 'iOS',
    'android': 'Android',
    'mac': 'macOS',
    'windows': 'Windows',
    'linux': 'Linux',
    'unknown': 'Unknown OS'
  };
  return osNames[os] || os;
}

/**
 * Check if the plugin should act as if in Light Mode
 * This is the key function - use this everywhere instead of just checking performanceMode setting
 */
export async function shouldUseLightMode(plugin: RNPlugin): Promise<boolean> {
  const performanceModeSetting = await plugin.settings.getSetting<string>('performanceMode');
  
  // If setting is already light, return true
  if (performanceModeSetting === 'light') {
    return true;
  }
  
  // If setting is full, check if we should override for mobile
  // CHANGED: Use session storage instead of synced storage to prevent cross-device sync
  const isMobile = await plugin.storage.getSession<boolean>(isMobileDeviceKey);
  const alwaysUseLightOnMobile = await plugin.settings.getSetting<boolean>(alwaysUseLightModeOnMobileId);
  
  // Override to light mode if on mobile and setting is enabled (default true)
  if (isMobile && alwaysUseLightOnMobile !== false) {
    return true;
  }
  
  return false;
}

/**
 * Get the effective performance mode (taking mobile override into account)
 */
export async function getEffectivePerformanceMode(plugin: RNPlugin): Promise<'light' | 'full'> {
  const useLightMode = await shouldUseLightMode(plugin);
  return useLightMode ? 'light' : 'full';
}

/**
 * Handle mobile detection and notifications on startup
 * This is the main function to call when the plugin initializes
 */
export async function handleMobileDetectionOnStartup(plugin: RNPlugin): Promise<void> {
  const os = await getOperatingSystem(plugin);
  const isMobile = os === 'ios' || os === 'android';
  const friendlyOSName = getFriendlyOSName(os);
  
  // CHANGED: Store whether device is mobile in SESSION storage (device-specific, doesn't sync)
  await plugin.storage.setSession(isMobileDeviceKey, isMobile);
  
  // Get settings
  const alwaysUseLightOnMobile = await plugin.settings.getSetting<boolean>(alwaysUseLightModeOnMobileId);
  const performanceModeSetting = await plugin.settings.getSetting<string>('performanceMode');
  
  // Get last detected OS (this can stay in synced storage for cross-device history tracking)
  const lastOS = await plugin.storage.getSynced<string>(lastDetectedOSKey);
  const osChanged = lastOS && lastOS !== os;
  
  // Store current OS for future comparison
  await plugin.storage.setSynced(lastDetectedOSKey, os);
  
  // Determine effective mode
  const effectiveMode = await getEffectivePerformanceMode(plugin);
  
  if (isMobile) {
    // ===== MOBILE DEVICE =====
    
    if (alwaysUseLightOnMobile !== false) { // true or undefined (default true)
      // Will use light mode regardless of setting
      if (performanceModeSetting === 'full') {
        await plugin.app.toast(`📱 ${friendlyOSName} detected: using Light Mode (Full Mode disabled on mobile for stability)`);
      } else {
        await plugin.app.toast(`📱 ${friendlyOSName} detected: running in Light Mode`);
      }
    } else {
      // User disabled auto-switch - warn them if in full mode
      if (performanceModeSetting === 'full') {
        await plugin.app.toast(`⚠️ ${friendlyOSName} detected: Full Mode can crash mobile. Consider enabling 'Always use Light Mode on mobile' in settings.`);
      } else {
        await plugin.app.toast(`📱 ${friendlyOSName} detected: running in Light Mode`);
      }
    }
    
  } else {
    // ===== DESKTOP DEVICE =====
    
    const modeText = effectiveMode === 'light' ? 'Light Mode' : 'Full Mode';
    
    if (osChanged && lastOS && (lastOS === 'ios' || lastOS === 'android')) {
      // Switched from mobile to desktop
      await plugin.app.toast(`💻 ${friendlyOSName} detected: now using ${modeText}`);
    } else {
      // Normal desktop startup
      await plugin.app.toast(`💻 ${friendlyOSName} detected: running in ${modeText}`);
    }
  }
}
