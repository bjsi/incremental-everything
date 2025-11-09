import { RNPlugin, Platform } from '@remnote/plugin-sdk';
import { alwaysUseLightModeOnMobileId, lastDetectedOSKey, isMobileDeviceKey, alwaysUseLightModeOnWebId, isWebPlatformKey, lastDetectedPlatformKey } from './consts';

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
 * Get the platform (app or web)
 */
export async function getPlatform(plugin: RNPlugin): Promise<Platform> {
  try {
    const platform = await plugin.app.getPlatform();
    return platform;
  } catch (error) {
    console.error('Error detecting platform via SDK:', error);
    // Fallback: assume 'web' if we can't determine
    return 'web';
  }
}

/**
 * Check if the current platform is web browser
 */
export async function isWebPlatform(plugin: RNPlugin): Promise<boolean> {
  const platform = await getPlatform(plugin);
  return platform === 'web';
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
 * Get a user-friendly platform name
 */
export function getFriendlyPlatformName(platform: Platform): string {
  return platform === 'web' ? 'Web Browser' : 'Desktop App';
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
  
  // If setting is full, check if we should override for mobile or web
  // IMPORTANT: Call detection functions directly to ensure we have current values
  const isMobile = await isMobileDevice(plugin);
  const alwaysUseLightOnMobile = await plugin.settings.getSetting<boolean>(alwaysUseLightModeOnMobileId);
  
  // Override to light mode if on mobile and setting is enabled (default true)
  if (isMobile && alwaysUseLightOnMobile !== false) {
    return true;
  }
  
  // Check web platform override - call detection directly
  const isWeb = await isWebPlatform(plugin);
  const alwaysUseLightOnWeb = await plugin.settings.getSetting<boolean>(alwaysUseLightModeOnWebId);
  
  // Override to light mode if on web and setting is enabled (default true)
  if (isWeb && alwaysUseLightOnWeb !== false) {
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
 * Handle mobile and platform detection with notifications on startup
 * This is the main function to call when the plugin initializes
 */
export async function handleMobileDetectionOnStartup(plugin: RNPlugin): Promise<void> {
  const os = await getOperatingSystem(plugin);
  const platform = await getPlatform(plugin);
  const isMobile = os === 'ios' || os === 'android';
  const isWeb = platform === 'web';
  const friendlyOSName = getFriendlyOSName(os);
  const friendlyPlatformName = getFriendlyPlatformName(platform);
  
  // Store device/platform info in SESSION storage (device-specific, doesn't sync)
  await plugin.storage.setSession(isMobileDeviceKey, isMobile);
  await plugin.storage.setSession(isWebPlatformKey, isWeb);
  
  // Get settings
  const alwaysUseLightOnMobile = await plugin.settings.getSetting<boolean>(alwaysUseLightModeOnMobileId);
  const alwaysUseLightOnWeb = await plugin.settings.getSetting<boolean>(alwaysUseLightModeOnWebId);
  const performanceModeSetting = await plugin.settings.getSetting<string>('performanceMode');
  
  // Get last detected OS and platform (for tracking changes across sessions)
  const lastOS = await plugin.storage.getSynced<string>(lastDetectedOSKey);
  const lastPlatform = await plugin.storage.getSynced<Platform>(lastDetectedPlatformKey);
  const osChanged = lastOS && lastOS !== os;
  const platformChanged = lastPlatform && lastPlatform !== platform;
  
  // Store current OS and platform for future comparison
  await plugin.storage.setSynced(lastDetectedOSKey, os);
  await plugin.storage.setSynced(lastDetectedPlatformKey, platform);
  
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
    
  } else if (isWeb) {
    // ===== WEB BROWSER (NON-MOBILE) =====
    
    if (alwaysUseLightOnWeb !== false) { // true or undefined (default true)
      // Will use light mode regardless of setting
      if (performanceModeSetting === 'full') {
        await plugin.app.toast(`🌐 ${friendlyPlatformName} on ${friendlyOSName}: using Light Mode (Full Mode disabled on web for performance)`);
      } else {
        await plugin.app.toast(`🌐 ${friendlyPlatformName} on ${friendlyOSName}: running in Light Mode`);
      }
    } else {
      // User disabled auto-switch - warn them if in full mode
      if (performanceModeSetting === 'full') {
        await plugin.app.toast(`⚠️ ${friendlyPlatformName} detected: Full Mode may be slow on web. Consider enabling 'Always use Light Mode on web' in settings.`);
      } else {
        await plugin.app.toast(`🌐 ${friendlyPlatformName} on ${friendlyOSName}: running in Light Mode`);
      }
    }
    
  } else {
    // ===== DESKTOP APP =====
    
    const modeText = effectiveMode === 'light' ? 'Light Mode' : 'Full Mode';
    
    if ((osChanged && lastOS && (lastOS === 'ios' || lastOS === 'android')) || 
        (platformChanged && lastPlatform === 'web')) {
      // Switched from mobile or web to desktop app
      await plugin.app.toast(`💻 ${friendlyPlatformName} on ${friendlyOSName}: now using ${modeText}`);
    } else {
      // Normal desktop startup
      await plugin.app.toast(`💻 ${friendlyPlatformName} on ${friendlyOSName}: running in ${modeText}`);
    }
  }

  console.log('Mobile detection completed');
}
