import {
  renderWidget,
  usePlugin,
  useTrackerPlugin,
} from '@remnote/plugin-sdk';
import React, { useState } from 'react';
import { createPriorityReviewDocument } from '../lib/priority_review_document';
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
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [successMessage, setSuccessMessage] = useState<string>('');

  const ratioToLabel = (ratio: number | 'no-cards' | 'no-rem'): string => {
    if (ratio === 'no-cards') return 'Only Incremental Rems';
    if (ratio === 'no-rem') return 'Only Flashcards';
    return `${ratio} flashcard${ratio !== 1 ? 's' : ''} for every incremental rem`;
  };

  const handleCreate = async () => {
    setIsCreating(true);
    setErrorMessage('');
    setSuccessMessage('');

    try {
      const config = {
        scopeRemId: useFullKB ? null : context?.scopeRemId || null,
        itemCount: itemCount,
        cardRatio: flashcardRatio || 6,
      };

      setSuccessMessage('Creating review document...');

      const { doc, actualItemCount } = await createPriorityReviewDocument(plugin, config);

      // Wait for document to be fully created
      await new Promise(resolve => setTimeout(resolve, 200));

      setSuccessMessage('Opening document...');

      // Open the document as a page
      await doc.openRemAsPage();

      // Show accurate count — note if scope had fewer items than requested
      if (actualItemCount < itemCount) {
        setSuccessMessage(
          `✅ Created review document with ${actualItemCount} items (scope had fewer than the ${itemCount} requested)`
        );
      } else {
        setSuccessMessage(`✅ Successfully created review document with ${actualItemCount} items`);
      }

      // Close the popup after a short delay so user sees the success message
      setTimeout(() => {
        plugin.widget.closePopup();
      }, 2000);

    } catch (error) {
      console.error('Error creating review document:', error);
      setErrorMessage('Failed to create review document. Check console for details.');
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
      setErrorMessage('Could not open sorting criteria settings');
    }
  };

  // Styles matching batch_card_priority.tsx
  const styles = {
    container: {
      padding: '20px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      maxWidth: '800px',
      margin: '0 auto',
    },
    header: {
      marginBottom: '20px',
    },
    title: {
      fontSize: '20px',
      fontWeight: 600,
      marginBottom: '8px',
    },
    subtitle: {
      fontSize: '14px',
      color: '#6b7280',
    },
    section: {
      marginBottom: '20px',
      padding: '16px',
      border: '1px solid #e5e7eb',
      borderRadius: '8px',
      backgroundColor: '#f9fafb',
    },
    sectionTitle: {
      fontSize: '16px',
      fontWeight: 600,
      marginBottom: '12px',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
    },
    input: {
      padding: '8px 12px',
      border: '1px solid #d1d5db',
      borderRadius: '6px',
      fontSize: '14px',
      width: '100px',
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
      fontSize: '14px',
    },
    button: {
      padding: '10px 20px',
      borderRadius: '6px',
      border: 'none',
      fontWeight: 600,
      fontSize: '14px',
      cursor: 'pointer',
      transition: 'background-color 0.2s',
    },
    primaryButton: {
      backgroundColor: '#3b82f6',
      color: 'white',
    },
    secondaryButton: {
      backgroundColor: '#6b7280',
      color: 'white',
      marginLeft: '8px',
    },
    infoBox: {
      padding: '12px',
      backgroundColor: '#eff6ff',
      border: '1px solid #bfdbfe',
      borderRadius: '8px',
      fontSize: '13px',
      color: '#1e3a8a',
    },
    contentMixValue: {
      padding: '8px 12px',
      backgroundColor: 'white',
      border: '1px solid #e5e7eb',
      borderRadius: '6px',
      fontSize: '14px',
      marginBottom: '12px',
    },
    error: {
      color: '#ef4444',
      fontSize: '14px',
      marginTop: '8px',
    },
    success: {
      color: '#10b981',
      fontSize: '14px',
      marginTop: '8px',
    },
  };

  if (!context || flashcardRatio === undefined) {
    return (
      <div style={styles.container}>
        <div>Loading...</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div style={styles.title}>Create Priority Review Document</div>
        <div style={styles.subtitle}>
          Build a scoped review document sorted by priority
        </div>
      </div>

      {/* Scope Selection */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Scope</div>
        <div style={styles.radioGroup}>
          <label style={styles.radioOption}>
            <input
              type="radio"
              checked={!useFullKB}
              onChange={() => setUseFullKB(false)}
              disabled={!context.scopeRemId || isCreating}
            />
            <span>Current Document: {context.scopeName}</span>
          </label>
          <label style={styles.radioOption}>
            <input
              type="radio"
              checked={useFullKB}
              onChange={() => setUseFullKB(true)}
              disabled={isCreating}
            />
            <span>Full Knowledge Base</span>
          </label>
        </div>
      </div>

      {/* Item Count */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Number of Items</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <input
            type="number"
            min={1}
            max={500}
            value={itemCount}
            onChange={(e) => setItemCount(Math.max(1, Math.min(500, parseInt(e.target.value) || 1)))}
            style={styles.input}
            disabled={isCreating}
          />
          <span style={{ fontSize: '12px', color: '#6b7280' }}>
            (Maximum items to include in the review document)
          </span>
        </div>
      </div>

      {/* Content Mix - READ ONLY with Settings Button */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Content Mix (from Sorting Criteria)</div>
        <div style={styles.contentMixValue}>
          {ratioToLabel(flashcardRatio)}
        </div>
        <button
          onClick={handleOpenSortingSettings}
          style={{ ...styles.button, ...styles.secondaryButton, marginLeft: 0, width: '100%' }}
          disabled={isCreating}
        >
          Change Sorting Criteria Settings
        </button>
      </div>

      {/* Info Box */}
      <div style={styles.infoBox}>
        <strong>How it works:</strong><br />
        • Items are selected based on priority and due date<br />
        • Sorting criteria (randomness and content mix) from your settings will be applied<br />
        • The document will open as a page after creation<br />
        • Practice RemNote regular document-scope queue from this Priority Review document<br />
        • After finishing the review of all Cards/IncRems, delete the created document<br />
        • You can find all your Priority Review Documents searching for the tag "Priority Review Queue"
      </div>

      {/* Summary and Actions */}
      <div style={{ marginTop: '20px' }}>
        <button
          onClick={handleCreate}
          style={{ ...styles.button, ...styles.primaryButton }}
          disabled={isCreating}
        >
          {isCreating ? 'Creating...' : 'Create Review Document'}
        </button>

        <button
          onClick={() => plugin.widget.closePopup()}
          style={{ ...styles.button, ...styles.secondaryButton }}
          disabled={isCreating}
        >
          Cancel
        </button>

        {errorMessage && <div style={styles.error}>{errorMessage}</div>}
        {successMessage && <div style={styles.success}>{successMessage}</div>}
      </div>
    </div>
  );
}

renderWidget(ReviewDocumentCreator);