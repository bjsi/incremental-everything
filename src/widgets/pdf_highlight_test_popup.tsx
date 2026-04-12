import { renderWidget, usePlugin, WidgetLocation, BuiltInPowerupCodes, PluginRem } from '@remnote/plugin-sdk';
import React, { useState, useEffect } from 'react';

export function PdfHighlightTestPopup() {
  const plugin = usePlugin();
  const [highlightRemId, setHighlightRemId] = useState<string | null>(null);
  const [pageText, setPageText] = useState<string | null>(null);
  const [pdfId, setPdfId] = useState<string | null | undefined>(null);
  const [pdfInternalId, setPdfInternalId] = useState<string | null>(null);
  const [pdfViewerData, setPdfViewerData] = useState<any>(null);
  const [pdfProperties, setPdfProperties] = useState<{readPercent?: string, lastRead?: string}>({});
  const [highlightData, setHighlightData] = useState<any>(null);
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

        if (remId) {
          setHighlightRemId(remId);
          
          const rem = await plugin.rem.findOne(remId);
          if (rem) {
            addLog(`Found Rem: ${rem.text ? await plugin.richText.toString(rem.text) : ''}`);
            
            // Check PDFHighlight powerup
            const isPdfHighlight = await rem.hasPowerup(BuiltInPowerupCodes.PDFHighlight);
            addLog(`isPdfHighlight: ${isPdfHighlight}`);
            
            if (isPdfHighlight) {
               const powerupObj = await rem.getPowerupProperty(BuiltInPowerupCodes.PDFHighlight, 'PdfId');
               addLog(`PdfId property: ${powerupObj}`);
               setPdfId(powerupObj);

               const highlightDataString = await rem.getPowerupProperty(BuiltInPowerupCodes.PDFHighlight, 'Data');
               if (highlightDataString) {
                 try {
                   const dataObj = JSON.parse(highlightDataString);
                   setHighlightData(dataObj);
                   addLog(`Parsed Data slot keys: ${Object.keys(dataObj).join(', ')}`);
                 } catch (e) {
                   addLog(`Error parsing Data slot: ${e}`);
                 }
               } else {
                 addLog(`No Data slot found`);
               }
            }

            // PDF Document Info
            let docRem: PluginRem | undefined = rem;
            let foundPdfRem: PluginRem | undefined;
            while (docRem) {
              const isPdf = await docRem.hasPowerup(BuiltInPowerupCodes.UploadedFile);
              if (isPdf) {
                 foundPdfRem = docRem;
                 break;
              }
              const parent = await docRem.getParentRem();
              if (!parent) break;
              docRem = parent;
            }

            if (foundPdfRem) {
                 setPdfInternalId(foundPdfRem._id);
                 addLog(`Found PDF Document: ${foundPdfRem._id}`);
                 const viewerDataStr = await foundPdfRem.getPowerupProperty(BuiltInPowerupCodes.UploadedFile, 'ViewerData');
                 if (viewerDataStr) {
                    try {
                      setPdfViewerData(JSON.parse(viewerDataStr));
                    } catch (e) {
                       addLog(`Error parsing ViewerData: ${e}`);
                       setPdfViewerData({ rawString: viewerDataStr });
                    }
                 }
                 
                 const readPercent = await foundPdfRem.getPowerupProperty(BuiltInPowerupCodes.UploadedFile, 'ReadPercent');
                 const lastReadDate = await foundPdfRem.getPowerupProperty(BuiltInPowerupCodes.UploadedFile, 'LastReadDate');
                 setPdfProperties({
                   readPercent: typeof readPercent === 'string' ? readPercent : JSON.stringify(readPercent), 
                   lastRead: typeof lastReadDate === 'string' ? lastReadDate : JSON.stringify(lastReadDate)
                 });
            } else {
                 addLog(`Could not find parent PDF Document`);
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
    <div style={{ padding: '10px', backgroundColor: '#eef', borderRadius: '5px', overflowY: 'auto', maxHeight: '400px' }}>
      <h4 style={{ margin: '0 0 10px 0'}}>PDF Bookmark Test Popup Widget</h4>
      <div><strong>Highlight Rem ID:</strong> {highlightRemId || 'N/A'}</div>
      <div><strong>PDF ID slot:</strong> {pdfId || 'N/A'}</div>
      <div><strong>Page Text:</strong> {pageText || 'N/A'}</div>
      
      {highlightData && (
        <>
          <hr style={{ margin: '10px 0' }} />
          <div><strong>Highlight Data Slot:</strong></div>
          <pre style={{ fontSize: '10px', whiteSpace: 'pre-wrap', backgroundColor: '#e0e0e0', padding: '5px', borderRadius: '3px' }}>
            {JSON.stringify(highlightData, null, 2)}
          </pre>
        </>
      )}

      {(pdfViewerData || pdfInternalId) && (
        <>
          <hr style={{ margin: '10px 0' }} />
          <div><strong>PDF Document:</strong> {pdfInternalId}</div>
          <div><strong>ReadPercent:</strong> {pdfProperties.readPercent || 'N/A'}</div>
          <div><strong>LastReadDate:</strong> {pdfProperties.lastRead || 'N/A'}</div>
          <div><strong>ViewerData Slot:</strong></div>
          <pre style={{ fontSize: '10px', whiteSpace: 'pre-wrap', backgroundColor: '#d1e7dd', padding: '5px', borderRadius: '3px' }}>
            {JSON.stringify(pdfViewerData, null, 2)}
          </pre>
        </>
      )}

      <hr style={{ margin: '10px 0' }} />
      <div><strong>Debug Logs:</strong></div>
      <pre style={{ fontSize: '10px', whiteSpace: 'pre-wrap' }}>
        {debugLogs.join('\n')}
      </pre>
    </div>
  );
}

renderWidget(PdfHighlightTestPopup);
