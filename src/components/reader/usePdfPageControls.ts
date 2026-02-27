import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { RNPlugin } from '@remnote/plugin-sdk';
import {
    getIncrementalReadingPosition,
    getIncrementalPageRange,
    clearIncrementalPDFData,
    PageRangeContext
} from '../../lib/pdfUtils';
import { pageRangeWidgetId } from '../../lib/consts';

export function usePdfPageControls(
    plugin: RNPlugin,
    incrementalRemId: string | undefined | null,
    pdfRemId: string | undefined | null,
    totalPages: number = 0
) {
    const [currentPage, setCurrentPage] = useState<number>(1);
    const [pageRangeStart, setPageRangeStart] = useState<number>(1);
    const [pageRangeEnd, setPageRangeEnd] = useState<number>(0);
    const [pageInputValue, setPageInputValue] = useState<string>('1');
    const [isInputFocused, setIsInputFocused] = useState<boolean>(false);

    const saveCurrentPage = useCallback(async (page: number) => {
        if (!incrementalRemId || !pdfRemId) return;
        const pageKey = `incremental_current_page_${incrementalRemId}_${pdfRemId}`;
        await plugin.storage.setSynced(pageKey, page);
    }, [incrementalRemId, pdfRemId, plugin]);

    const incrementPage = useCallback(() => {
        const newPage = currentPage + 1;
        const maxPage = pageRangeEnd > 0 ? Math.min(pageRangeEnd, totalPages || Infinity) : (totalPages || Infinity);

        if (newPage <= maxPage) {
            setCurrentPage(newPage);
            setPageInputValue(newPage.toString());
            saveCurrentPage(newPage);
        }
    }, [currentPage, totalPages, pageRangeEnd, saveCurrentPage]);

    const decrementPage = useCallback(() => {
        const minPage = Math.max(1, pageRangeStart);
        const newPage = Math.max(minPage, currentPage - 1);

        setCurrentPage(newPage);
        setPageInputValue(newPage.toString());
        saveCurrentPage(newPage);
    }, [currentPage, pageRangeStart, saveCurrentPage]);

    const handlePageInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setPageInputValue(value);

        const page = parseInt(value);
        if (!isNaN(page) && page >= 1) {
            const minPage = Math.max(1, pageRangeStart);
            const maxPage = pageRangeEnd > 0 ? Math.min(pageRangeEnd, totalPages || Infinity) : (totalPages || Infinity);

            if (page >= minPage && page <= maxPage) {
                setCurrentPage(page);
                saveCurrentPage(page);
            }
        }
    }, [pageRangeStart, pageRangeEnd, totalPages, saveCurrentPage]);

    const handlePageInputBlur = useCallback(() => {
        setIsInputFocused(false);
        const page = parseInt(pageInputValue);

        if (isNaN(page) || page < 1) {
            setPageInputValue(currentPage.toString());
        } else {
            const minPage = Math.max(1, pageRangeStart);
            const maxPage = pageRangeEnd > 0 ? Math.min(pageRangeEnd, totalPages || Infinity) : (totalPages || Infinity);

            if (page < minPage || page > maxPage) {
                const message = pageRangeEnd > 0
                    ? `Page must be between ${minPage} and ${maxPage}`
                    : `Page must be ${minPage} or higher`;

                plugin.app.toast(message);
                setPageInputValue(currentPage.toString());
            } else if (page !== currentPage) {
                setCurrentPage(page);
                saveCurrentPage(page);
            }
        }
    }, [pageInputValue, currentPage, pageRangeStart, pageRangeEnd, totalPages, saveCurrentPage, plugin]);

    const handlePageInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
        }
    }, []);

    const handleSetPageRange = useCallback(async () => {
        if (!incrementalRemId || !pdfRemId) return;

        const context: PageRangeContext = {
            incrementalRemId: incrementalRemId as any,
            pdfRemId: pdfRemId,
            totalPages: totalPages,
            currentPage: currentPage
        };

        await plugin.storage.setSession('pageRangeContext', context);
        await plugin.storage.setSession('pageRangePopupOpen', true);
        await plugin.widget.openPopup(pageRangeWidgetId);
    }, [incrementalRemId, pdfRemId, totalPages, currentPage, plugin]);

    const handleClearPageRange = useCallback(async () => {
        if (!incrementalRemId || !pdfRemId) return;

        await clearIncrementalPDFData(plugin, incrementalRemId, pdfRemId);
        setPageRangeStart(1);
        setPageRangeEnd(0);
        setCurrentPage(1);
        setPageInputValue('1');
    }, [incrementalRemId, pdfRemId, plugin]);

    useEffect(() => {
        if (!incrementalRemId || !pdfRemId) return;

        const loadAndValidateSettings = async () => {
            const savedPagePromise = getIncrementalReadingPosition(plugin, incrementalRemId, pdfRemId);
            const rangePromise = getIncrementalPageRange(plugin, incrementalRemId, pdfRemId);

            const [savedPage, range] = await Promise.all([savedPagePromise, rangePromise]);

            const startRange = range?.start || 1;
            const endRange = range?.end || 0;
            setPageRangeStart(startRange);
            setPageRangeEnd(endRange);

            let initialPage = savedPage && savedPage > 0 ? savedPage : startRange;
            const minPage = Math.max(1, startRange);
            if (initialPage < minPage) { initialPage = minPage; }
            if (endRange > 0 && initialPage > endRange) { initialPage = endRange; }

            setCurrentPage(initialPage);
            setPageInputValue(initialPage.toString());
        };

        loadAndValidateSettings();

        const checkForChanges = async () => {
            const range = await getIncrementalPageRange(plugin, incrementalRemId, pdfRemId);
            const newStart = range?.start || 1;
            const newEnd = range?.end || 0;

            if (newStart !== pageRangeStart || newEnd !== pageRangeEnd) {
                setPageRangeStart(newStart);
                setPageRangeEnd(newEnd);

                const minPage = Math.max(1, newStart);
                const maxPage = newEnd > 0 ? Math.min(newEnd, totalPages || Infinity) : (totalPages || Infinity);

                setCurrentPage(currentVal => {
                    let correctedPage = currentVal;
                    if (currentVal < minPage) { correctedPage = minPage; }
                    else if (currentVal > maxPage) { correctedPage = maxPage; }

                    if (correctedPage !== currentVal) {
                        setPageInputValue(correctedPage.toString());
                        saveCurrentPage(correctedPage);
                        return correctedPage;
                    }
                    return currentVal;
                });
            }
        };

        const intervalId = setInterval(checkForChanges, 2000);
        return () => clearInterval(intervalId);
    }, [plugin, incrementalRemId, pdfRemId, pageRangeStart, pageRangeEnd, totalPages, saveCurrentPage]);

    const metadataBarStyles = useMemo(() => ({
        pageButton: {
            padding: '4px 8px',
            fontSize: '12px',
            borderRadius: '6px',
            border: '1px solid var(--rn-clr-border-primary)',
            backgroundColor: 'var(--rn-clr-background-primary)',
            color: 'var(--rn-clr-content-primary)',
            cursor: 'pointer',
            transition: 'all 0.15s ease',
            fontWeight: 500
        },
        pageInput: {
            width: '50px',
            padding: '4px 6px',
            fontSize: '12px',
            borderRadius: '6px',
            border: '1px solid var(--rn-clr-border-primary)',
            textAlign: 'center' as const,
            backgroundColor: 'var(--rn-clr-background-primary)',
            color: 'var(--rn-clr-content-primary)',
        },
        pageLabel: {
            fontSize: '11px',
            color: 'var(--rn-clr-content-tertiary)'
        },
        rangeButton: {
            padding: '4px 10px',
            fontSize: '11px',
            borderRadius: '6px',
            border: '1px solid var(--rn-clr-border-primary)',
            backgroundColor: 'var(--rn-clr-background-primary)',
            color: 'var(--rn-clr-content-secondary)',
            cursor: 'pointer',
            transition: 'all 0.15s ease',
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            gap: '4px'
        },
        clearButton: {
            padding: '4px 8px',
            fontSize: '11px',
            color: 'var(--rn-clr-red, #dc2626)',
            cursor: 'pointer',
            transition: 'opacity 0.15s ease',
            opacity: 0.7,
            border: 'none',
            background: 'none'
        },
        activeRangeButton: {
            backgroundColor: 'var(--rn-clr-blue-light, #eff6ff)',
            borderColor: 'var(--rn-clr-blue, #3b82f6)',
            color: 'var(--rn-clr-blue, #1e40af)',
        },
        dividerColor: 'var(--rn-clr-border-primary)'
    }), []);

    return {
        currentPage,
        setCurrentPage,
        pageRangeStart,
        pageRangeEnd,
        pageInputValue,
        isInputFocused,
        setIsInputFocused,
        metadataBarStyles,
        onIncrement: incrementPage,
        onDecrement: decrementPage,
        onInputChange: handlePageInputChange,
        onInputBlur: handlePageInputBlur,
        onInputFocus: () => setIsInputFocused(true),
        onInputKeyDown: handlePageInputKeyDown,
        onSetRange: handleSetPageRange,
        onClearRange: handleClearPageRange
    };
}
