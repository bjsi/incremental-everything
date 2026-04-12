import { renderWidget, usePlugin, WidgetLocation, BuiltInPowerupCodes, PluginRem } from '@remnote/plugin-sdk';
import React, { useState, useEffect } from 'react';

export function PdfHighlightTest() {
  const plugin = usePlugin();
  const [highlightRemId, setHighlightRemId] = useState<string | null>(null);
  const [pageText, setPageText] = useState<string | null>(null);
  const [pdfId, setPdfId] = useState<string | null | undefined>(null);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  
  const addLog = (msg: string) => setDebugLogs(prev => [...prev, msg]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        addLog('Fetching context...');
        let remId: string | undefined;
        
        // Try getting context from Popup location first
        try {
          const popupContext = await plugin.widget.getWidgetContext<WidgetLocation.PDFHighlightPopupLocation>();
          if (popupContext && popupContext.remId) {
            remId = popupContext.remId;
            addLog(`Found via PopupLocation: ${remId}`);
          }
        } catch (e) {
             addLog(`PopupLocation wait error: ${e}`);
        }

        if (!remId) {
          try {
            const toolbarContext = await plugin.widget.getWidgetContext<WidgetLocation.PDFHighlightToolbarLocation>();
            if (toolbarContext && toolbarContext.remId) {
              remId = toolbarContext.remId;
              addLog(`Found via ToolbarLocation: ${remId}`);
            }
          } catch(e) {
            addLog(`ToolbarLocation wait error`);
          }
        }

        if (remId) {
          setHighlightRemId(remId);
          
          const rem = await plugin.rem.findOne(remId);
          if (rem) {
            addLog(`Found Rem: ${rem.text ? await plugin.richText.toString(rem.text) : ''}`);
            
            // Check PDFHighlight powerup
            const isPdfHighlight = await rem.hasPowerup(BuiltInPowerupCodes.PDFHighlight);
            addLog(`isPdfHighlight: ${isPdfHighlight}`);
            
            if (isPdfHighlight) {
               // Try to get PdfId slot
               // Since slot name might be "PdfId" or "Source", let's use the standard "PdfId" proposed
               // For a builtin powerup, we could do:
               const powerupObj = await rem.getPowerupProperty(BuiltInPowerupCodes.PDFHighlight, 'PdfId');
               addLog(`PdfId property: ${powerupObj}`);
               setPdfId(powerupObj);
            }

            // Hierarchical Approach (Using PDFPageNumber)
            let currentRem: PluginRem | undefined = rem;
            let iterations = 0;
            while (currentRem && iterations < 10) {
              iterations++;
              const isPageRem = await currentRem.hasPowerup(BuiltInPowerupCodes.PDFPageNumber);
              if (isPageRem) {
                 addLog(`Found Page Rem at iteration ${iterations}`);
                 const pageTextRich = currentRem.text;
                 if (pageTextRich) {
                   const pageString = await plugin.richText.toString(pageTextRich);
                   setPageText(pageString);
                   addLog(`Page string parsed: ${pageString}`);
                 }
                 break;
              }
              const parent = await currentRem.getParentRem();
              if (parent) {
                  currentRem = parent;
              } else {
                  break;
              }
            }
          }
        } else {
           addLog('No remId found in context');
        }
      } catch (err) {
        addLog(`Error: ${err}`);
      }
    };
    
    fetchData();
  }, [plugin]);

  return (
    <div style={{ padding: '10px', backgroundColor: '#f0f0f0', borderRadius: '5px', overflowY: 'auto', maxHeight: '400px' }}>
      <h4 style={{ margin: '0 0 10px 0'}}>PDF Bookmark Test Widget</h4>
      <div><strong>Highlight Rem ID:</strong> {highlightRemId || 'N/A'}</div>
      <div><strong>PDF ID slot:</strong> {pdfId || 'N/A'}</div>
      <div><strong>Page Text:</strong> {pageText || 'N/A'}</div>
      <hr style={{ margin: '10px 0' }} />
      <div><strong>Debug Logs:</strong></div>
      <pre style={{ fontSize: '10px', whiteSpace: 'pre-wrap' }}>
        {debugLogs.join('\n')}
      </pre>
    </div>
  );
}

renderWidget(PdfHighlightTest);
