import { ReactRNPlugin, renderWidget, usePlugin } from '@remnote/plugin-sdk';
import { useState, useRef, useEffect } from 'react';

export async function jumpToRemById(remId: string, pluginOverride?: ReactRNPlugin) {
  if (!remId || typeof remId !== 'string' || remId.trim() === '') {
    console.error('❌ Invalid RemId provided');
    console.log("Usage: jumpToRemById('your-rem-id-here')");
    console.log("Example: jumpToRemById('abc123xyz')");
    throw new Error('RemId cannot be empty');
  }

  const plugin = pluginOverride ?? (window as any).__plugin;
  if (!plugin) {
    console.error('❌ Plugin not found. Make sure the Incremental Everything plugin is loaded.');
    console.log('Try reloading the plugin from RemNote Settings → Plugins');
    throw new Error('Plugin not found');
  }

  const normalizedId = remId.trim();

  console.log(`🔍 Searching for rem: ${normalizedId}...`);
  const rem = await plugin.rem.findOne(normalizedId);

  if (!rem) {
    console.error(`❌ Rem not found: ${normalizedId}`);
    console.log('💡 Possible reasons:');
    console.log('   • The rem was deleted');
    console.log('   • The RemId is incorrect');
    console.log('   • The rem is from a different knowledge base');
    throw new Error(`Rem not found: ${normalizedId}`);
  }

  const remText = await rem.text;
  const textPreview = remText ? (typeof remText === 'string' ? remText : '[Complex content]') : '[No text]';
  const preview = textPreview.length > 100 ? textPreview.substring(0, 100) + '...' : textPreview;

  console.log(`✅ Found rem: "${preview}"`);
  console.log('📍 Opening rem in RemNote...');
  await plugin.window.openRem(rem);

  return { rem, preview };
}

export function JumpToRemInput() {
  const plugin = usePlugin();
  const [remId, setRemId] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus the input when the widget opens
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!remId || remId.trim() === '') {
      setError('RemId cannot be empty');
      return;
    }
    
    try {
      const { preview } = await jumpToRemById(remId.trim(), plugin);
      await plugin.app.toast(`✅ Found: ${preview.substring(0, 40)}...`);

      // Close the popup
      await plugin.widget.closePopup();
      
    } catch (error) {
      console.error('❌ Error finding rem:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      setError(message);
      console.log('💡 Try reloading the plugin if this error persists.');
    }
  };

  return (
    <div className="flex flex-col p-4 gap-4">
      <div className="text-2xl font-bold">Jump to Rem by ID</div>
      
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <label htmlFor="rem-id-input" className="font-semibold">
            Enter RemId:
          </label>
          <input
            ref={inputRef}
            id="rem-id-input"
            type="text"
            value={remId}
            onChange={(e) => {
              setRemId(e.target.value);
              setError(''); // Clear error when user types
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleSubmit(e);
              }
            }}
            placeholder="e.g., tfhQYD3Q2wDw4VWUH"
            className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800"
          />
          {error && (
            <div className="text-red-600 dark:text-red-400 text-sm">
              {error}
            </div>
          )}
        </div>
        
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => plugin.widget.closePopup()}
            className="px-4 py-2 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="px-4 py-2 font-semibold rounded"
            style={{
              backgroundColor: '#3B82F6',
              color: 'white',
              border: 'none',
            }}
          >
            Jump to Rem
          </button>
        </div>
      </form>
      
      <div className="text-xs text-gray-500 dark:text-gray-400 mt-2">
        💡 Tip: You can find RemIds in the pre-computation error log
      </div>
    </div>
  );
}

renderWidget(JumpToRemInput);
