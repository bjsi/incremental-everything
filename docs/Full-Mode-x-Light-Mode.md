# Performance Modes: Quick Reference Card

## 🎯 Choose Your Mode in 30 Seconds

### Do you have an extremely overloaded workflow?
- **YES** (50+ articles, 10k+ cards, complex hierarchies) → **Full Mode** 🖥️
- **NO** (Standard learning / Beginner) → **Light Mode** ⚡

---

!!! important "Performance Mode is now the *second* switch to consider"
    Since v1.0.33 the plugin's heaviest work — tagging flashcard-bearing Rems across your knowledge base and keeping those tags in step — is behind a separate opt-in, **Enable Flashcard Prioritisation**, which is **off by default**.

    With that switch off, Full Mode no longer starts the startup pretagging pass and no longer cascades priorities down your document tree, so the gap between the two modes is far smaller than this page describes. Everything below applies once you have turned flashcard prioritisation on — see [Priorities for Flashcards](Priorities-for-Flashcards.md#the-opt-in).

## 📊 At a Glance

### Full Mode 🖥️
```
Platform:    💻 Desktop App ONLY
Performance: 🐢 Slower but feature-rich
Features:    🎛️ All advanced features
Startup:     ⏱️ up to 3 min (depending on KB size)
Best For:    🔬 Overloaded Students, Power Users
```

**Key Features:**
- KB-scoped and Document-scoped relative priority percentiles
- [Priority Shield](Prioritization-&-Sorting.md#priority-shield) (KB and Document scope)
- [Priority Shield](Prioritization-&-Sorting.md#priority-shield) stats are stored for historical comparison used the Priority Shield Graph
- Complex hierarchy support

### Light Mode ⚡
```
Platform:    🌐 Web, 📱 Mobile, 💻 Desktop
Performance: 🚀 Fast and responsive
Features:    ⚡ Essential features
Startup:     ⚡ <10 seconds
Best For:    🎓 Beginner and eventual users, Mobile and Web-browser users, users with few flashcards
```

**Key Features:**
- Absolute Priorities (flashcards and IncRems)
- No need for cache mounting of the startup / queue Enter
- Universal platform support

---

## 🚦 Platform Recommendations

| Platform | Default | Recommended | Can Override? |
|----------|---------|-------------|---------------|
| 🌐 **Web Browser** | Light | Light ✅ | Yes (not recommended) |
| 📱 **Mobile** | Light | Light ✅ | Yes (not recommended) |
| 💻 **Desktop App** | Light | Full/Light ⚡ | Yes (configurable) |

---

## 💡 Common Scenarios

### "I study on my phone during commute"
→ **Light Mode** ✅ (automatic)  
Optimized for mobile, won't make the app heavy

### "I process 5 articles a week on web browser"
→ **Light Mode** ✅ (automatic)  
Fast, stable, perfect for standard IR

### "I'm researching my PhD with 100+ papers"
→ **Full Mode** on Desktop App  
Need document percentiles and advanced features

### "I have 500 cards, use desktop app"
→ **Light Mode** works great! ⚡  
Unless you want document-level analytics

### "I have 20K+ cards, a large backlog, a huge inflow of information, and a use desktop app"
→ **Full Mode** ! ⚡  
You need the full power of relative priorities and [priority shield](Prioritization-&-Sorting.md#priority-shield).

### "I switch between web and desktop daily"
→ **Hybrid**: Full on Desktop, Light on Web  
Automatic switching, best of both worlds

---

## 🔧 How to Change Modes

### Automatic (Recommended)
The plugin auto-detects your platform (if you chose Full Mode):
```
✅ Web → Light Mode
✅ Mobile → Light Mode  
✅ Desktop → Full Mode
```

### Manual Override
**Settings → Performance Mode**
- Choose "Light Mode" or "Full Mode"

**Platform-Specific Settings:**
- "Always use Light Mode on Mobile" (default: ON)
- "Always use Light Mode on Web Browser" (default: ON)

---

## ⚠️ Warning Signs

### Using Full Mode on Wrong Platform

**Web Browser + Full Mode:**
```
❌ Slow loading
❌ Browser freezing
❌ High memory usage
→ Solution: Enable "Light Mode on Web" setting
```

**Mobile + Full Mode:**
```
❌ App crashes
❌ Battery drain
❌ Sluggish interface
→ Solution: Enable "Light Mode on Mobile" setting
```

---

## 🎓 Feature Availability

| Feature | Full Mode | Light Mode |
|---------|:---------:|:----------:|
| Flashcard Review | ✅ | ✅ |
| Incremental Reading | ✅ | ✅ |
| Priority System | ✅ | ✅ |
| Absolute Priority Number (IncRems and Cards) | ✅ | ✅ |
| KB Relative Priorities Percentiles | ✅ | ❌ |
| Document Relative Priorities Percentiles | ✅ | ❌ |
| KB Priority Shield (IncRems and Cards) | ✅ | ❌ |
| Doc Priority Shield (IncRems and Cards) | ✅ | ❌ |
| [Priority Review Docs](Priority-Review-Document.md) | ✅ | ✅ |
| Card Priority Tagging | ✅ Deep | ✅ Instant |
| Fast Startup | ❌ | ✅ |
| Mobile Stability | ❌ | ✅ |

---




## If you regularly uses RemNote in the Desktop App, don't fear the FULL MODE: shouldUseLightMode() Decision Flow

```
┌─────────────────────────────────────────────────────────────┐
│         User Opens RemNote Plugin / Component Loads         │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
            ┌────────────────────────┐
            │ Call shouldUseLightMode│
            │      (plugin)          │
            └────────────┬───────────┘
                         │
                         ▼
            ┌────────────────────────┐
            │ Check: Performance     │
            │ setting === 'light'?   │
            └──────┬─────────────┬───┘
                   │ YES         │ NO
                   ▼             ▼
            [USE LIGHT MODE]     │
                                 │
                    ┌────────────▼──────────────┐
                    │ Check: Is Mobile Device?  │
                    │ (iOS or Android)          │
                    └──────┬─────────────┬──────┘
                           │ YES         │ NO
                           ▼             │
            ┌──────────────────────┐    │
            │ Check: alwaysUseLight│    │
            │ ModeOnMobile enabled?│    │
            └──────┬───────────┬───┘    │
                   │ YES       │ NO     │
                   ▼           │        │
            [USE LIGHT MODE]   │        │
                               │        │
                    ┌──────────▼────────▼──────────┐
                    │ Check: Is Web Platform?      │
                    │ (browser vs desktop app)     │
                    └──────┬─────────────┬─────────┘
                           │ YES         │ NO
                           ▼             │
            ┌──────────────────────┐    │
            │ Check: alwaysUseLight│    │
            │ ModeOnWeb enabled?   │    │
            └──────┬───────────┬───┘    │
                   │ YES       │ NO     │
                   ▼           │        │
            [USE LIGHT MODE]   │        │
                               │        │
                    ┌──────────▼────────▼──────────┐
                    │      USE FULL MODE           │
                    └──────────────────────────────┘
```

## Startup Detection Flow

```
┌────────────────────────────────────────────────┐
│        Plugin Activates (onActivate)           │
└───────────────────┬────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────┐
│     handleMobileDetectionOnStartup(plugin)              │
├─────────────────────────────────────────────────────────┤
│  1. Detect OS (iOS/Android/Windows/Mac/Linux)          │
│  2. Detect Platform (web/app)                          │
│  3. Store in SESSION storage (device-specific):        │
│     - isMobileDeviceKey = true/false                   │
│     - isWebPlatformKey = true/false                    │
│  4. Store in SYNCED storage (for history):             │
│     - lastDetectedOSKey = current OS                   │
│     - lastDetectedPlatformKey = current platform       │
└───────────────────┬─────────────────────────────────────┘
                    │
        ┌───────────┴───────────┐
        │                       │
        ▼                       ▼
┌──────────────┐    ┌───────────────────┐
│ Mobile?      │    │ Web Platform?     │
│ (iOS/Android)│    │ (browser)         │
└──────┬───────┘    └────────┬──────────┘
       │ YES                  │ YES
       ▼                      ▼
┌──────────────────┐  ┌──────────────────────┐
│ Show toast:      │  │ Show toast:          │
│ "📱 iOS detected"│  │ "🌐 Web Browser on   │
│ with mode info   │  │  Windows" + mode     │
└──────────────────┘  └──────────────────────┘
```

## Storage Architecture

```
SESSION STORAGE (per-device, doesn't sync)
┌────────────────────────────────────────┐
│  isMobileDeviceKey: boolean            │  ← Used by shouldUseLightMode()
│  isWebPlatformKey: boolean             │  ← Used by shouldUseLightMode()
└────────────────────────────────────────┘

SYNCED STORAGE (cross-device)
┌────────────────────────────────────────┐
│  lastDetectedOSKey: string             │  ← For tracking changes
│  lastDetectedPlatformKey: Platform     │  ← For tracking changes
└────────────────────────────────────────┘

SETTINGS (user preferences)
┌────────────────────────────────────────┐
│  performanceMode: 'light' | 'full'     │  ← Master setting
│  alwaysUseLightModeOnMobileId: bool    │  ← Mobile override
│  alwaysUseLightModeOnWebId: bool       │  ← Web override (NEW)
└────────────────────────────────────────┘
```

## Platform Combinations

```
╔═══════════════════╦════════════╦═══════════╦═════════════════╗
║   Operating       ║  Platform  ║  Device   ║  Default Mode   ║
║   System          ║            ║  Type     ║  (recommended)  ║
╠═══════════════════╬════════════╬═══════════╬═════════════════╣
║ iOS               ║  app       ║  Mobile   ║  Light          ║
║ Android           ║  app       ║  Mobile   ║  Light          ║
║ Windows           ║  web       ║  Desktop  ║  Light (NEW)    ║
║ Mac               ║  web       ║  Desktop  ║  Light (NEW)    ║
║ Linux             ║  web       ║  Desktop  ║  Light (NEW)    ║
║ Windows           ║  app       ║  Desktop  ║  Full           ║
║ Mac               ║  app       ║  Desktop  ║  Full           ║
║ Linux             ║  app       ║  Desktop  ║  Full           ║
╚═══════════════════╩════════════╩═══════════╩═════════════════╝
```

## Component Usage Pattern

```
┌─────────────────────────────────────────────────────┐
│  Any Component (Widget/Popup/Command)               │
├─────────────────────────────────────────────────────┤
│                                                     │
│  const useLightMode = await shouldUseLightMode(    │
│    plugin                                           │
│  );                                                 │
│                                                     │
│  if (useLightMode) {                                │
│    // Use optimized, fast path                     │
│    // Skip expensive operations                    │
│    // Use lighter caching                          │
│  } else {                                           │
│    // Use full-featured path                       │
│    // Run comprehensive operations                 │
│    // Use full caching                             │
│  }                                                  │
│                                                     │
└─────────────────────────────────────────────────────┘
```

## Real-World Example: answer_buttons.tsx

```
User clicks "Dismiss (untag)" button
           │
           ▼
┌──────────────────────────────┐
│ handleCardPriorityInheritance│
├──────────────────────────────┤
│ Check existing priority      │
│          │                   │
│          ▼                   │
│ const useLightMode =         │
│   await shouldUseLightMode() │
│          │                   │
│     ┌────┴────┐              │
│     │ Light?  │              │
│     └─┬─────┬─┘              │
│ YES   │     │  NO            │
│   ┌───▼─┐   ▼────────┐       │
│   │Skip │   │ Check  │       │
│   │card │   │ cards  │       │
│   │check│   │ in Rem │       │
│   │     │   │ and    │       │
│   │Set  │   │ 3 level│       │
│   │prio │   │ descend│       │
│   │NOW  │   │        │       │
│   └─────┘   └────────┘       │
│   ⚡Fast     🔍 Thorough      │
└──────────────────────────────┘
```
