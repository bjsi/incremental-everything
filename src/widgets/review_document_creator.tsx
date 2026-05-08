import {
  renderWidget,
  usePlugin,
  useTrackerPlugin,
} from '@remnote/plugin-sdk';
import React, { useState, useRef, useEffect } from 'react';
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

  const scopeFirstRadioRef = useRef<HTMLInputElement>(null);
  const scopeSecondRadioRef = useRef<HTMLInputElement>(null);
  const numberInputRef = useRef<HTMLInputElement>(null);
  const hasFocused = useRef(false);

  useEffect(() => {
    if (context && flashcardRatio !== undefined && !hasFocused.current) {
      hasFocused.current = true;
      if (context.scopeRemId && scopeFirstRadioRef.current) {
        scopeFirstRadioRef.current.focus();
      } else {
        scopeSecondRadioRef.current?.focus();
      }
    }
  }, [context, flashcardRatio]);

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

  const focusCurrentScopeRadio = () => {
    if (!useFullKB && context?.scopeRemId && scopeFirstRadioRef.current) {
      scopeFirstRadioRef.current.focus();
    } else {
      scopeSecondRadioRef.current?.focus();
    }
  };

  const handleWrapperKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isCreating) {
      e.preventDefault();
      handleCreate();
    }
  };

  const handleScopeKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (context?.scopeRemId && !isCreating) {
        setUseFullKB(false);
        scopeFirstRadioRef.current?.focus();
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!isCreating) {
        setUseFullKB(true);
        scopeSecondRadioRef.current?.focus();
      }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      numberInputRef.current?.focus();
    }
  };

  const handleNumberInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      focusCurrentScopeRadio();
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

  if (!context || flashcardRatio === undefined) {
    return (
      <div className="p-5">
        <div>Loading...</div>
      </div>
    );
  }

  return (
    <div className="p-5 flex flex-col gap-4" style={{ fontFamily: 'system-ui, -apple-system, sans-serif', maxWidth: '800px', margin: '0 auto' }} onKeyDown={handleWrapperKeyDown}>

      {/* Header */}
      <div>
        <div className="text-xl font-semibold mb-1">Create Priority Review Document</div>
        <div className="rn-clr-content-secondary text-sm">
          Build a scoped review document sorted by priority
        </div>
      </div>

      {/* Scope Selection */}
      <div className="rn-clr-background-secondary rounded-lg border border-gray-300 p-4" style={{ borderColor: 'var(--rn-clr-border, #e5e7eb)' }} onKeyDown={handleScopeKeyDown}>
        <div className="flex items-start gap-6">
          <div className="font-semibold whitespace-nowrap" style={{ width: '80px' }}>Scope</div>
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                ref={scopeFirstRadioRef}
                type="radio"
                checked={!useFullKB}
                onChange={() => setUseFullKB(false)}
                disabled={!context.scopeRemId || isCreating}
              />
              <span>Current Document: {context.scopeName}</span>
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                ref={scopeSecondRadioRef}
                type="radio"
                checked={useFullKB}
                onChange={() => setUseFullKB(true)}
                disabled={isCreating}
              />
              <span>Full Knowledge Base</span>
            </label>
          </div>
        </div>
      </div>

      {/* Item Count */}
      <div className="rn-clr-background-secondary rounded-lg p-4" style={{ border: '1px solid var(--rn-clr-border, #e5e7eb)' }}>
        <div className="flex items-start gap-6">
          <div className="font-semibold" style={{ width: '80px', lineHeight: '1.1', paddingTop: '4px' }}>Number of Items</div>
          <div className="flex items-center gap-3">
            <input
              ref={numberInputRef}
              type="number"
              min={1}
              max={500}
              value={itemCount}
              onChange={(e) => setItemCount(Math.max(1, Math.min(500, parseInt(e.target.value) || 1)))}
              onKeyDown={handleNumberInputKeyDown}
              className="rn-clr-background rounded"
              style={{
                padding: '8px 12px',
                border: '1px solid var(--rn-clr-border, #d1d5db)',
                fontSize: '14px',
                width: '100px',
              }}
              disabled={isCreating}
            />
            <span className="rn-clr-content-secondary text-xs">
              (Maximum items to include)
            </span>
          </div>
        </div>
      </div>

      {/* Content Mix - READ ONLY with Settings Button */}
      <div className="rn-clr-background-secondary rounded-lg p-4" style={{ border: '1px solid var(--rn-clr-border, #e5e7eb)' }}>
        <div className="font-semibold mb-3">Content Mix (from Sorting Criteria)</div>
        <div
          className="rn-clr-background rn-clr-content-primary rounded mb-3"
          style={{
            padding: '8px 12px',
            border: '1px solid var(--rn-clr-border, #e5e7eb)',
            fontSize: '14px',
          }}
        >
          {ratioToLabel(flashcardRatio)}
        </div>
        <button
          onClick={handleOpenSortingSettings}
          style={{
            padding: '10px 20px',
            borderRadius: '6px',
            border: 'none',
            fontWeight: 600,
            fontSize: '14px',
            cursor: 'pointer',
            backgroundColor: '#6b7280',
            color: 'white',
            width: '100%',
            transition: 'background-color 0.2s',
          }}
          disabled={isCreating}
        >
          Change Sorting Criteria Settings
        </button>
      </div>

      {/* Info Box */}
      <div
        className="rounded-lg"
        style={{
          padding: '12px',
          backgroundColor: 'rgba(59, 130, 246, 0.12)',
          border: '1px solid rgba(59, 130, 246, 0.35)',
          borderRadius: '8px',
          fontSize: '13px',
          color: 'var(--rn-clr-content-primary, #1e3a8a)',
        }}
      >
        <strong>How it works:</strong><br />
        • Items are selected based on priority and due date<br />
        • Sorting criteria (randomness and content mix) from your settings will be applied<br />
        • The document will open as a page after creation<br />
        • Practice RemNote regular document-scope queue from this Priority Review document<br />
        • After finishing the review of all Cards/IncRems, delete the created document<br />
        • You can find all your Priority Review Documents searching for the tag "Priority Review Queue"
      </div>

      {/* Summary and Actions */}
      <div className="flex items-center gap-2 flex-wrap mt-1">
        <button
          onClick={handleCreate}
          style={{
            padding: '10px 20px',
            borderRadius: '6px',
            border: 'none',
            fontWeight: 600,
            fontSize: '14px',
            cursor: 'pointer',
            backgroundColor: '#3b82f6',
            color: 'white',
            transition: 'background-color 0.2s',
          }}
          disabled={isCreating}
        >
          {isCreating ? 'Creating...' : 'Create Review Document'}
        </button>

        <button
          onClick={() => plugin.widget.closePopup()}
          style={{
            padding: '10px 20px',
            borderRadius: '6px',
            border: 'none',
            fontWeight: 600,
            fontSize: '14px',
            cursor: 'pointer',
            backgroundColor: '#6b7280',
            color: 'white',
            transition: 'background-color 0.2s',
          }}
          disabled={isCreating}
        >
          Cancel
        </button>
      </div>

      {errorMessage && (
        <div style={{ color: '#ef4444', fontSize: '14px' }}>{errorMessage}</div>
      )}
      {successMessage && (
        <div style={{ color: '#10b981', fontSize: '14px' }}>{successMessage}</div>
      )}
    </div>
  );
}

renderWidget(ReviewDocumentCreator);