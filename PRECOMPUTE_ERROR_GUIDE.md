# Pre-compute Card Priorities - Error Guide

## Understanding the Error Report

When you run the pre-computation, you'll now see an enhanced error report like this:

```
✅ Pre-computation complete!

• Total rems processed: 41010
• Newly tagged: 40948
• Preserved manual priorities: 62
• Errors: 268
• Error breakdown:
  - Rem not found: 245
  - Processing exceptions: 23
• Total time: 443s
• Cache build time: 142s

Check console for detailed error log.

Future startups will be much faster!
```

## Error Types Explained

### 1. "Rem not found" Errors
**What it means:** The card references a Rem that no longer exists in your knowledge base.

**Why this happens:**
- The Rem was deleted but the card still exists
- Database inconsistency
- The card's parent Rem was removed

**Impact:** 
- ❌ The card was **NOT** tagged with cardPriority
- ❌ No priority was assigned
- The card may not appear correctly in the queue

**How to fix:**
1. Check the console for the RemId
2. Try to find the card in RemNote, using the plugin "Jum to Rem by ID" command (Ctrl+/)
3. If found, the card might be orphaned - consider deleting it
4. If not found, the error should resolve on next run after card cleanup

### 2. "Processing exceptions" Errors
**What it means:** An unexpected error occurred while processing the Rem.

**Common causes:**
- Permission issues
- Corrupted Rem data
- Network timeout during processing
- Bug in the code logic

**Impact:**
- ❌ The card was **NOT** tagged with cardPriority
- ❌ No priority was assigned
- The Rem needs manual investigation

**How to fix:**
1. Check the detailed error log in console
2. Look for the specific error message
3. Try to open the Rem manually in RemNote
4. If the Rem is accessible, you can manually set priority using Alt+P
5. Report the error details if it seems like a plugin bug

## How to Investigate Errors

### Use the Plugin Command (Easiest)

1. Open RemNote's command palette (Ctrl+/ or Cmd+/)
2. Type "Jump to Rem by ID"
3. Select the command
4. Paste the RemId from your error log
5. The plugin will:
   - Find the rem (if it exists)
   - Show you a preview of its content
   - Open it automatically


### Step 1: Check the Console
After pre-computation, open your browser's Developer Console (F12) and look for:

```
=== DETAILED ERROR LOG ===
Total errors: 268

Error 1/268:
  RemId: abc123xyz
  Reason: Rem not found - may have been deleted
  
Error 2/268:
  RemId: def456uvw
  Reason: Exception during processing: Cannot read property 'text' of undefined
  Details: [error object]
  
...
```

### Step 2: Get the List of Failed RemIds
At the end of the error log, you'll find:

```
=== FAILED REM IDs (for investigation) ===
abc123xyz
def456uvw
ghi789rst
...
=== END FAILED REM IDS ===
```

You can copy this list and:
1. Search for these Rems in RemNote
2. Check if they still exist
3. Manually assign priorities if needed

### Step 3: Re-run Pre-computation
After fixing issues:
1. Run pre-computation again
2. Check if error count decreased
3. Most "Rem not found" errors should auto-resolve after card cleanup

## Important Notes

### Error Count vs Failed Tagging
- **Error count** = Rems that failed to process
- **Newly tagged** = Rems that were successfully tagged


### When to Worry
- **< 100 errors out of 10,000+ rems:** Normal, likely deleted/orphaned cards
- **> 1,000 errors:** May indicate a systemic issue, investigate
- **All errors are "exceptions":** Likely a plugin bug, report it

## Next Steps
1. Review the detailed error log in console
2. Investigate any "Processing exception" errors (these are more concerning than "not found")
3. Run pre-computation again after fixing issues
4. Most errors should resolve automatically on subsequent runs
