import { renderWidget, usePlugin } from '@remnote/plugin-sdk';
import { useState, useRef, useEffect } from 'react';

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
      console.log(`🔍 Searching for rem: ${remId}...`);
      const rem = await plugin.rem.findOne(remId.trim());
      
      if (!rem) {
        console.error(`❌ Rem not found: ${remId}`);
        setError(`Rem not found: ${remId}`);
        return;
      }
      
      const remText = await rem.text;
      const textPreview = remText ? (typeof remText === 'string' ? remText : '[Complex content]') : '[No text]';
      const preview = textPreview.length > 100 ? textPreview.substring(0, 100) + '...' : textPreview;
      
      console.log(`✅ Found rem: "${preview}"`);
      await plugin.app.toast(`✅ Found: ${preview.substring(0, 40)}...`);
      
      // Close the popup
      await plugin.widget.closePopup();
      
      // Open the rem
      console.log('📍 Opening rem in RemNote...');
      await plugin.window.openRem(rem);
      
    } catch (error) {
      console.error('❌ Error finding rem:', error);
      setError(`Error: ${error}`);
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
