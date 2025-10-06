import {
  renderWidget,
  usePlugin,
  useTrackerPlugin,
  WidgetLocation,
} from '@remnote/plugin-sdk';
import React, { useState, useEffect } from 'react';
import { createPriorityReviewDocument } from '../lib/priorityReviewDocument';
import { getCardsPerRem } from '../lib/sorting';

function ReviewDocumentCreator() {
  const plugin = usePlugin();
  
  // Get context from session (scope information)
  const context = useTrackerPlugin(
    async (rp) => {
      const ctx = await rp.storage.getSession('reviewDocContext');
      return ctx as { scopeRemId: string | null; scopeName: string } | null;
    },
    []
  );
  
  // Get current flashcard ratio setting
  const flashcardRatio = useTrackerPlugin(
    async (rp) => await getCardsPerRem(rp),
    []
  );
  
  // Form state
  const [itemCount, setItemCount] = useState(50);
  const [useFullKB, setUseFullKB] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  
  const ratioToLabel = (ratio: number | 'no-cards' | 'no-rem'): string => {
    if (ratio === 'no-cards') return 'Only Incremental Rems';
    if (ratio === 'no-rem') return 'Only Flashcards';
    return `${ratio} flashcard${ratio !== 1 ? 's' : ''} for every incremental rem`;
  };
  
  const handleCreate = async () => {
    setIsCreating(true);
    
    try {
      const config = {
        scopeRemId: useFullKB ? null : context?.scopeRemId || null,
        itemCount: itemCount,
        cardRatio: flashcardRatio || 6,
      };
      
      const doc = await createPriorityReviewDocument(plugin, config);
      
      // Wait for document to be fully created
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Open the document as a page
      await doc.openRemAsPage();
      
      await plugin.app.toast(`Created review document with ${itemCount} items`);
      
      // Close the popup
      plugin.widget.closePopup();
      
    } catch (error) {
      console.error('Error creating review document:', error);
      await plugin.app.toast('Error creating review document');
    } finally {
      setIsCreating(false);
    }
  };
  
  const handleOpenSortingSettings = async () => {
    try {
      // Open sorting criteria as a popup
      await plugin.widget.openPopup('sorting_criteria');
    } catch (error) {
      console.error('Error opening sorting criteria:', error);
      await plugin.app.toast('Could not open sorting criteria settings');
    }
  };
  
  // Styles matching the existing widgets
  const styles = {
    container: {
      padding: '16px',
      display: 'flex',
      flexDirection: 'column' as const,
      gap: '16px',
      minWidth: '450px',
    },
    title: {
      fontSize: '24px',
      fontWeight: 'bold',
    },
    section: {
      display: 'flex',
      flexDirection: 'column' as const,
      gap: '8px',
    },
    label: {
      fontWeight: 600,
      fontSize: '14px',
    },
    input: {
      padding: '6px 10px',
      borderRadius: '6px',
      border: '1px solid #d1d5db',
      fontSize: '14px',
    },
    sublabel: {
      fontSize: '12px',
      color: '#6b7280',
      marginTop: '4px',
    },
    radioGroup: {
      display: 'flex',
      flexDirection: 'column' as const,
      gap: '8px',
    },
    radioOption: {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
    },
    buttonGroup: {
      display: 'flex',
      gap: '8px',
      justifyContent: 'flex-end',
      marginTop: '8px',
    },
    button: {
      padding: '8px 16px',
      borderRadius: '6px',
      border: 'none',
      cursor: 'pointer',
      fontWeight: 500,
      fontSize: '14px',
    },
    primaryButton: {
      backgroundColor: '#3b82f6',
      color: 'white',
    },
    secondaryButton: {
      backgroundColor: '#6b7280',
      color: 'white',
    },
    infoBox: {
      padding: '12px',
      backgroundColor: '#eff6ff',
      border: '1px solid #3b82f6',
      borderRadius: '6px',
      fontSize: '13px',
    },
  };
  
  if (!context || flashcardRatio === undefined) {
    return <div style={styles.container}>Loading...</div>;
  }
  
  return (
    <div style={styles.container}>
      <div style={styles.title}>Create Priority Review Document</div>
      
      {/* Scope Selection */}
      <div style={styles.section}>
        <div style={styles.label}>Scope</div>
        <div style={styles.radioGroup}>
          <label style={styles.radioOption}>
            <input
              type="radio"
              checked={!useFullKB}
              onChange={() => setUseFullKB(false)}
              disabled={!context.scopeRemId}
            />
            <span>Current Document: {context.scopeName}</span>
          </label>
          <label style={styles.radioOption}>
            <input
              type="radio"
              checked={useFullKB}
              onChange={() => setUseFullKB(true)}
            />
            <span>Full Knowledge Base</span>
          </label>
        </div>
      </div>
      
      {/* Item Count */}
      <div style={styles.section}>
        <label style={styles.label}>Number of Items</label>
        <input
          type="number"
          min={1}
          max={500}
          value={itemCount}
          onChange={(e) => setItemCount(Math.max(1, Math.min(500, parseInt(e.target.value) || 1)))}
          style={styles.input}
        />
        <div style={styles.sublabel}>
          Maximum number of items to include in the review document
        </div>
      </div>
      
      {/* Content Mix - READ ONLY with Settings Button */}
      <div style={styles.section}>
        <label style={styles.label}>Content Mix (from Sorting Criteria)</label>
        <div style={{
          padding: '12px',
          backgroundColor: '#f3f4f6',
          borderRadius: '6px',
          fontSize: '14px',
          marginBottom: '8px'
        }}>
          {ratioToLabel(flashcardRatio)}
        </div>
        <button
          onClick={handleOpenSortingSettings}
          style={{
            ...styles.button,
            backgroundColor: '#6b7280',
            color: 'white',
            width: '100%'
          }}
          disabled={isCreating}
        >
          Change Sorting Criteria Settings
        </button>
      </div>
      
      {/* Info Box */}
      <div style={styles.infoBox}>
        <strong>How it works:</strong><br/>
        • Items are selected based on priority and due date<br/>
        • Sorting criteria (randomness and content mix) from your settings will be applied<br/>
        • The document will open as a page after creation<br/>
        • Items reviewed can be marked as complete
      </div>
      
      {/* Buttons */}
      <div style={styles.buttonGroup}>
        <button
          onClick={() => plugin.widget.closePopup()}
          style={{ ...styles.button, ...styles.secondaryButton }}
          disabled={isCreating}
        >
          Cancel
        </button>
        <button
          onClick={handleCreate}
          style={{ ...styles.button, ...styles.primaryButton }}
          disabled={isCreating}
        >
          {isCreating ? 'Creating...' : 'Create Review Document'}
        </button>
      </div>
    </div>
  );
}

renderWidget(ReviewDocumentCreator);