# Jump to Rem by ID - User Guide

## 📖 Overview

The "Jump to Rem by ID" feature allows you to quickly navigate to any rem in your knowledge base using its RemId. This is especially useful when investigating errors from the pre-computation process or debugging issues with specific rems.

---

## 🚀 Quick Start

### Using the Plugin Command (Recommended)

1. **Press `Ctrl+/`** (or `Cmd+/` on Mac)
2. **Type:** `Jump to Rem by ID`
3. **Enter the RemId** in the popup dialog
4. **Press Enter** or click "Jump to Rem"
5. **Done!** The rem opens automatically

**Example:**
```
Ctrl+P → "Jump to Rem" → tfhQYD3Q2wDw4VWUH → Enter → ✅
```

---

## 🎯 Common Use Cases

### 1. Investigating Pre-computation Errors

When you run "Pre-compute Card Priorities" and see errors:

**Step 1:** Check the console for error details
```
Error 15/268:
  RemId: tfhQYD3Q2wDw4VWUH  ← Copy this
  Reason: Processing exception
```

**Step 2:** Jump to the rem
- `Ctrl+/` → "Jump to Rem by ID"
- Paste: `tfhQYD3Q2wDw4VWUH`
- Press Enter

**Step 3:** Investigate
- View the rem's content
- Check if it's corrupted
- Fix any issues
- Re-run pre-computation

### 2. Checking Multiple Failed Rems

When you have a list of failed RemIds:

```
=== FAILED REM IDs ===
abc123xyz
def456uvw
ghi789rst
```

**Quick workflow:**
1. `Ctrl+/` → "Jump to Rem by ID"
2. Paste first RemId → Enter
3. Investigate the rem
4. Repeat for next RemId (command stays in recent commands)

**Pro tip:** The command stays in your command history, so just press `Ctrl+P` and it will be at the top of your recent commands!

### 3. Verifying Orphaned Cards

When you see "Rem not found" errors:

**Use Jump to Rem to confirm:**
- If popup shows "Rem not found" → The rem was deleted (orphaned)
- If rem opens → The rem exists (error was temporary)

---

## 🎨 The Popup Dialog

When you run the command, a popup appears with:

```
┌─────────────────────────────────────┐
│  Jump to Rem by ID                  │
│                                     │
│  Enter RemId:                       │
│  ┌─────────────────────────────┐   │
│  │ e.g., tfhQYD3Q2wDw4VWUH    │   │
│  └─────────────────────────────┘   │
│                                     │
│          [Cancel]  [Jump to Rem]   │
│                                     │
│  💡 Tip: Find RemIds in the         │
│     pre-computation error log       │
└─────────────────────────────────────┘
```

### Features:
- ✅ **Auto-focused input** - Start typing immediately
- ✅ **Enter key support** - Press Enter to submit
- ✅ **Error messages** - Clear feedback if RemId is invalid
- ✅ **Cancel button** - Close without action
- ✅ **Dark mode** - Adapts to your theme

---

## ⌨️ Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| Open command palette | `Ctrl+/` / `Cmd+/` |
| Submit form | `Enter` |
| Close popup | `Escape` |
| Focus input | Automatic |

---

## 🔍 Understanding RemIds

### What is a RemId?

A RemId is a unique identifier for every rem in RemNote. It looks like this:
```
tfhQYD3Q2wDw4VWUH
```

### Where to Find RemIds:

1. **Pre-computation error logs** (Console, F12)
   ```
   Error 15/268:
     RemId: tfhQYD3Q2wDw4VWUH
   ```

2. **URL bar** when viewing a rem
   ```
   https://www.remnote.com/document/tfhQYD3Q2wDw4VWUH
   ```

3. **Developer tools** (for debugging)
   ```javascript
   const rem = await plugin.focus.getFocusedRem();
   console.log(rem._id); // Prints RemId
   ```

---

## ✅ Success Messages

### When rem is found:
```
🔍 Searching for rem: tfhQYD3Q2wDw4VWUH...
✅ Found rem: "What is the capital of France?"
📍 Opening rem in RemNote...
```

**Result:** 
- Popup closes automatically
- Rem opens in RemNote
- Toast notification: "✅ Found: What is the capital..."

### When rem is not found:
```
🔍 Searching for rem: tfhQYD3Q2wDw4VWUH...
❌ Rem not found: tfhQYD3Q2wDw4VWUH
💡 Possible reasons:
   • The rem was deleted
   • The RemId is incorrect
   • The rem is from a different knowledge base
```

**Result:**
- Error message shown in popup: "Rem not found: tfhQYD3Q2wDw4VWUH"
- Popup stays open so you can try again
- Toast notification: "❌ Rem not found"

---

## 🚨 Error Messages & Solutions

### Error: "RemId cannot be empty"
**Cause:** You clicked "Jump to Rem" without entering anything

**Solution:** Enter a RemId in the input field

---

### Error: "Rem not found: [RemId]"
**Cause:** The rem with this ID doesn't exist in your knowledge base

**Possible reasons:**
1. The rem was deleted
2. You copied the RemId incorrectly
3. The rem is in a different knowledge base
4. Typo in the RemId

**Solutions:**
- Double-check you copied the full RemId
- Verify you're in the correct knowledge base
- Check if the rem was recently deleted
- Try another RemId from your error list

---

### Error: "Error: [technical message]"
**Cause:** Unexpected error during processing

**Solutions:**
1. Try again (might be temporary)
2. Reload the plugin (Settings → Plugins → Toggle off/on)
3. Check console for detailed error (F12)
4. Report bug if error persists

---

## 💡 Tips & Tricks

### Tip 1: Use Command History
After using the command once, press `Ctrl+/` and it appears at the top of recent commands. Just press Enter to open it again!

### Tip 2: Keep Console Open
When investigating multiple errors, keep the browser console open (F12) so you can easily copy RemIds.

### Tip 3: Copy Multiple RemIds
Copy all failed RemIds at once from the console, then paste them one by one into the dialog.

### Tip 4: Check Patterns
If many rems are "not found," they might have been deleted. If many have "processing exceptions," there might be a systematic issue.

### Tip 5: Create Bookmarks
For rems you investigate frequently, consider bookmarking them in RemNote after jumping to them.

---

## 🔧 Troubleshooting

### Problem: Command doesn't appear in command palette

**Solution:**
1. Ensure plugin is enabled (Settings → Plugins)
2. Reload the plugin (Toggle off/on)
3. Rebuild the plugin (`npm run build`)
4. Restart RemNote

---

### Problem: Popup doesn't open

**Solution:**
1. Check browser console for errors (F12)
2. Verify `jump_to_rem_input.tsx` is in `src/widgets/`
3. Rebuild plugin (`npm run build`)
4. Clear browser cache
5. Reload plugin

---

### Problem: Input field doesn't auto-focus

**Solution:**
- Click in the input field manually
- This is a minor UI issue and doesn't affect functionality

---

### Problem: Dark mode looks wrong

**Solution:**
- The widget should auto-detect your theme
- If not, try refreshing RemNote
- Report bug if it persists

---

## 📊 Workflow Examples

### Example 1: Quick Single Lookup

**Scenario:** You see one error in pre-computation

**Steps:**
1. Copy RemId from console: `tfhQYD3Q2wDw4VWUH`
2. `Ctrl+/` → "Jump to Rem by ID"
3. Paste RemId → Enter
4. Investigate rem
5. Done!

**Time:** ~5 seconds

---

### Example 2: Investigating 10 Failed Rems

**Scenario:** Pre-computation shows 10 errors

**Steps:**
1. Open console (F12)
2. Find list of failed RemIds
3. For each RemId:
   - `Ctrl+/` (command is already at top)
   - Enter key
   - Paste RemId
   - Enter
   - Investigate
   - Take notes
4. Identify patterns
5. Fix issues
6. Re-run pre-computation

**Time:** ~2 minutes

---

### Example 3: Verifying Orphaned Cards

**Scenario:** 50 "Rem not found" errors

**Steps:**
1. Copy first 5 RemIds
2. Try to jump to each one
3. If all return "not found" → They're all orphaned
4. No need to check remaining 45
5. These cards can be ignored or cleaned up

**Time:** ~30 seconds

---

## 🎓 Understanding the Feature

### Why was this feature created?

During pre-computation of card priorities, some rems may fail to process. To investigate these errors, you need to:
1. Find the rem by its ID
2. Examine its content
3. Determine why it failed
4. Fix the issue

Without this feature, finding a rem by ID was difficult. RemNote doesn't have a built-in "search by ID" function, so this plugin adds that capability.

### What happens behind the scenes?

When you enter a RemId:
1. Plugin validates the input
2. Searches for the rem using `plugin.rem.findOne(remId)`
3. If found, opens it using `plugin.window.openRem(rem)`
4. If not found, displays helpful error message

---

## 📚 Related Features

### Pre-compute Card Priorities
- Command: "Pre-compute Card Priorities"
- Generates the errors you'll investigate with Jump to Rem
- Run before using Jump to Rem feature

### Test Console Function
- Command: "Test Console Function"
- Verifies the plugin is working correctly
- Useful for debugging

### Refresh Card Priority Cache
- Command: "Refresh Card Priority Cache"
- Rebuilds cache after fixing issues
- Run after investigating and fixing failed rems

---

## 🎯 Best Practices

1. **Always check console first** - Error logs provide context
2. **Investigate exceptions before "not found"** - Exceptions are more concerning
3. **Look for patterns** - Similar errors might have common cause
4. **Take notes** - Document what you find for each RemId
5. **Re-run pre-computation** - After fixing issues, verify they're resolved
6. **Use batch approach** - Check multiple rems in one session

---

## 📝 Summary

### What You Learned:
- ✅ How to use Jump to Rem by ID command
- ✅ Common use cases and workflows
- ✅ Understanding error messages
- ✅ Troubleshooting steps
- ✅ Tips for efficient investigation

### Key Takeaways:
- **Fastest method:** `Ctrl+/` → "Jump to Rem by ID"
- **Most common use:** Investigating pre-computation errors
- **Pro tip:** Command stays in history for quick access
- **When rem opens:** Investigation successful ✅
- **When "not found":** Rem was likely deleted ⚠️

---

## 🆘 Getting Help

If you encounter issues:

1. **Check this guide** - Most questions are answered here
2. **Check console** (F12) - Look for error messages
3. **Reload plugin** - Often fixes temporary issues
4. **Rebuild plugin** - If code was changed
5. **Report bug** - If problem persists

---

## 🎉 You're Ready!

You now know everything about using the Jump to Rem by ID feature. Start investigating those pre-computation errors and cleaning up your knowledge base!

**Quick reference:**
```
Ctrl+P → "Jump to Rem by ID" → Paste RemId → Enter → Investigate!
```

Happy investigating! 🔍✨
