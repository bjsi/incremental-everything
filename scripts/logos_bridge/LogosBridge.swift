// LogosBridge — sends passages from Logos Bible Software to Incremental RemNote.
//
// Logos for Mac has no automation API (no AppleScript dictionary, no COM, no
// local server), so this helper works from the outside:
//   ⌃⌥X   in Logos: presses Logos's own Edit ▸ Copy through Accessibility, reads
//         what Logos puts on the clipboard (formatted text, the citation and a
//         ref.ly deep link to the selection), puts the user's clipboard back, and
//         asks for priority and interval in a small panel floating over Logos.
//   ⌃⌥⇧X  the same without the panel: inherited priority, default interval.
//   ⌃⌥B   saves the reading position as the IncRem's Logos bookmark — from the
//         selection when there is one, otherwise from Logos's history database.
//   ⌃⌥N   creates an IncRem for the open book: a top-level Rem tagged #Logos,
//         with its bookmark at the current position, and switches to RemNote,
//         where the plugin has opened it.
// After an extract it can press a Logos highlighter shortcut key, so the passage
// is marked as extracted in Logos too (config.json → "highlightKey").
//
// The plugin (src/lib/logos_bridge.ts) long-polls GET /next on 127.0.0.1:3458
// and does the RemNote writes. The split is forced: the plugin iframe can fetch
// localhost but cannot run anything or be called from outside.
//
// Build, install and (re)start: scripts/logos_bridge/build.sh

import AppKit
import ApplicationServices
import Carbon.HIToolbox
import Network
import SQLite3
import SwiftUI

let bridgeVersion = "0.1.0"
let logosBundleId = "com.logos.desktop.logos"
let remNoteBundleId = "io.remnote"
let homeDir = FileManager.default.homeDirectoryForCurrentUser
let supportDir = homeDir.appendingPathComponent(".incremental-remnote/logos-bridge")
let logosRoot = homeDir.appendingPathComponent("Library/Application Support/Logos4")

func log(_ message: String) {
    let line = "[\(ISO8601DateFormatter().string(from: Date()))] \(message)\n"
    FileHandle.standardError.write(Data(line.utf8))
}

// MARK: - Config

struct Config: Codable {
    var port: UInt16 = 3458
    /// Logos highlighter shortcut key (one letter or digit) pressed after each extract; "" = off.
    var highlightKey: String = ""
    /// Origins allowed to call the bridge; empty = any page on this machine.
    var allowedOrigins: [String] = []

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        port = try c.decodeIfPresent(UInt16.self, forKey: .port) ?? 3458
        highlightKey = try c.decodeIfPresent(String.self, forKey: .highlightKey) ?? ""
        allowedOrigins = try c.decodeIfPresent([String].self, forKey: .allowedOrigins) ?? []
    }

    /// Read on every use, so editing config.json needs no restart (except for the port).
    static func load() -> Config {
        let url = supportDir.appendingPathComponent("config.json")
        if let data = try? Data(contentsOf: url) {
            if let config = try? JSONDecoder().decode(Config.self, from: data) { return config }
            log("config.json is not valid JSON — using defaults")
            return Config()
        }
        let config = Config()
        try? FileManager.default.createDirectory(at: supportDir, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try? encoder.encode(config).write(to: url)
        return config
    }
}

// MARK: - Wire format (mirrored in src/lib/logos_bridge_format.ts)

struct Segment: Codable, Equatable {
    var text: String
    var b: Bool? = nil
    var i: Bool? = nil
    var u: Bool? = nil
    var sup: Bool? = nil
    var sub: Bool? = nil

    func sameStyle(as other: Segment) -> Bool {
        b == other.b && i == other.i && u == other.u && sup == other.sup && sub == other.sub
    }
}

struct Capture: Codable {
    var segments: [Segment]
    var plain: String
    var citation: String? = nil
    /// The book title: the italic part of the citation Logos appends.
    var title: String? = nil
    /// ref.ly deep link to the start of the selection.
    var link: String? = nil
    /// "Short title, p. 35" — the text of the link back to Logos.
    var label: String? = nil
    var resourceId: String? = nil
    /// res/<resource id>/<version>/<absolute offset>?len=<length>
    var range: String? = nil

    var preview: String { segments.map(\.text).joined() }

    /// The selection's absolute offset in the book, from `range`.
    var absoluteOffset: Int? {
        range?.split(separator: "?").first?.split(separator: "/").last.flatMap { Int($0) }
    }
}

struct Context: Codable {
    var targetId: String?
    var targetTitle: String?
    var targetIsFocused: Bool?
    var incRemId: String?
    var incRemTitle: String?
    var defaultPriority: Int?
    var defaultInterval: Int?
    var problem: String?
    /// The request this answers (POST /context carries it back).
    var forJob: String?
    /// lookupBook: the book's existing IncRem, already opened in RemNote by the plugin.
    var existingBookId: String?
    var existingBookTitle: String?
}

struct Job: Codable {
    var id = UUID().uuidString
    var type: String  // "context" | "extract" | "bookmark"
    var createdAt = Date().timeIntervalSince1970 * 1000
    var targetId: String? = nil
    var capture: Capture? = nil
    var priority: Int? = nil
    var interval: Int? = nil
    var incremental: Bool? = nil
    var link: String? = nil
    var label: String? = nil
    var title: String? = nil
    var resourceId: String? = nil
}

// MARK: - Logos rich text (clipboard flavour "Libronix.DigitalLibrary.RichText")

/// Logos's copy is XAML-like: <Span>/<Run Text="…"/> carry the passage with
/// FontBold/FontItalic attributes, and a <Footnote IsCitation="True"> holds the
/// citation with a <UriLink Uri="https://ref.ly/…"> to the selection. Other
/// footnotes (the book's own notes) are dropped, markers included.
final class RichTextParser: NSObject, XMLParserDelegate {
    private struct Style { var b = false, i = false, u = false, sup = false, sub = false }
    private var styles = [Style()]
    private var footnoteDepth = 0
    private var inCitation = false
    private var pendingBreak = false
    private(set) var segments: [Segment] = []
    private(set) var citation = ""
    private(set) var citationTitle = ""
    private(set) var link: String?

    static func parse(_ xml: String) -> RichTextParser? {
        let result = RichTextParser()
        // A copy holds several top-level elements (the passage, then the citation).
        let parser = XMLParser(data: Data("<Root>\(xml)</Root>".utf8))
        parser.delegate = result
        return parser.parse() ? result : nil
    }

    func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?,
                qualifiedName: String?, attributes a: [String: String] = [:]) {
        var style = styles.last ?? Style()
        func flag(_ key: String) -> Bool? { a[key].map { $0.lowercased() == "true" } }
        if let v = flag("FontBold") { style.b = v }
        if let v = flag("FontItalic") { style.i = v }
        if let v = flag("FontUnderline") { style.u = v }
        for value in a.values {
            if value == "Superscript" { style.sup = true }
            if value == "Subscript" { style.sub = true }
        }
        styles.append(style)

        switch name {
        case "Footnote":
            footnoteDepth += 1
            if a["IsCitation"]?.lowercased() == "true" { inCitation = true }
        case "UriLink":
            if inCitation, link == nil { link = a["Uri"] }
        case "Run":
            if let text = a["Text"] { emit(text, style) }
        case "LineBreak":
            emit("\n", style)
        default:
            break
        }
    }

    func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?) {
        if styles.count > 1 { styles.removeLast() }
        switch name {
        case "Footnote":
            footnoteDepth -= 1
            if footnoteDepth == 0 { inCitation = false }
        case "Paragraph":
            if footnoteDepth == 0 && !segments.isEmpty { pendingBreak = true }
        default:
            break
        }
    }

    private func emit(_ text: String, _ style: Style) {
        if footnoteDepth > 0 {
            if inCitation {
                citation += text
                if style.i { citationTitle += text }
            }
            return
        }
        if pendingBreak {
            pendingBreak = false
            append("\n", Style())
        }
        append(text, style)
    }

    private func append(_ text: String, _ style: Style) {
        let segment = Segment(text: text, b: style.b ? true : nil, i: style.i ? true : nil,
                              u: style.u ? true : nil, sup: style.sup ? true : nil, sub: style.sub ? true : nil)
        if let last = segments.last, last.sameStyle(as: segment) {
            segments[segments.count - 1].text += text
        } else {
            segments.append(segment)
        }
    }
}

func trimmed(_ segments: [Segment]) -> [Segment] {
    var result = segments.filter { !$0.text.isEmpty }
    if !result.isEmpty {
        result[0].text = String(result[0].text.drop(while: { $0.isWhitespace }))
        let last = result.count - 1
        while let c = result[last].text.last, c.isWhitespace { result[last].text.removeLast() }
    }
    return result.filter { !$0.text.isEmpty }
}

/// "Page.p+35" → "p. 35"; other reference kinds are shown as Logos writes them.
func referenceLabel(fromLink link: String) -> String? {
    guard let ref = URLComponents(string: link)?.queryItems?.first(where: { $0.name == "ref" })?.value else { return nil }
    let readable = ref.replacingOccurrences(of: "+", with: " ")
    if readable.hasPrefix("Page.p") {
        return "p. " + readable.dropFirst("Page.p".count).trimmingCharacters(in: .whitespaces)
    }
    return readable
}

func sourceLabel(title: String?, link: String?) -> String? {
    // Titles run long ("Christ the End of the Law: Being the Preface to…"); the part before the colon is enough.
    let shortTitle = title?.split(separator: ":").first.map { $0.trimmingCharacters(in: .whitespaces) }
    let parts = [shortTitle, link.flatMap(referenceLabel(fromLink:))].compactMap { $0 }.filter { !$0.isEmpty }
    return parts.isEmpty ? nil : parts.joined(separator: ", ")
}

// MARK: - Clipboard

enum Clipboard {
    static let richText = NSPasteboard.PasteboardType("Libronix.DigitalLibrary.RichText")
    static let textRange = NSPasteboard.PasteboardType("Libronix.DigitalLibrary.ResourceTextRangeDropData")
    static let resourceId = NSPasteboard.PasteboardType("Libronix.DigitalLibrary.SourceResourceId")

    typealias Snapshot = [[(NSPasteboard.PasteboardType, Data)]]

    static func snapshot(_ pb: NSPasteboard) -> Snapshot {
        (pb.pasteboardItems ?? []).map { item in
            item.types.compactMap { type in item.data(forType: type).map { (type, $0) } }
        }
    }

    static func restore(_ pb: NSPasteboard, _ snapshot: Snapshot) {
        pb.clearContents()
        let items = snapshot.map { pairs -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (type, data) in pairs { item.setData(data, forType: type) }
            return item
        }
        if !items.isEmpty { pb.writeObjects(items) }
    }

    static func readCapture(_ pb: NSPasteboard) -> Capture? {
        let plain = pb.string(forType: .string) ?? ""
        var capture = Capture(segments: [], plain: plain)

        if let xml = pb.string(forType: richText), let parsed = RichTextParser.parse(xml) {
            capture.segments = trimmed(parsed.segments)
            let citation = parsed.citation.trimmingCharacters(in: .whitespacesAndNewlines)
            capture.citation = citation.isEmpty ? nil : citation
            let title = parsed.citationTitle.trimmingCharacters(in: .whitespacesAndNewlines)
            capture.title = title.isEmpty ? nil : title
            capture.link = parsed.link
        }
        if capture.segments.isEmpty {
            // No rich flavour: plain text, minus the citation Logos appends to it.
            var text = plain
            if let citation = capture.citation, let r = text.range(of: citation, options: .backwards) {
                text = String(text[..<r.lowerBound])
            }
            capture.segments = trimmed([Segment(text: text)])
        }
        if let json = pb.string(forType: textRange),
           let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] {
            capture.resourceId = object["resourceId"] as? String
            capture.range = object["savedTextRange"] as? String
        }
        if capture.resourceId == nil { capture.resourceId = pb.string(forType: resourceId) }
        capture.label = sourceLabel(title: capture.title, link: capture.link)
        return capture.segments.isEmpty ? nil : capture
    }
}

// MARK: - Logos (the running app)

let letterKeyCodes: [String: Int] = [
    "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E, "f": kVK_ANSI_F,
    "g": kVK_ANSI_G, "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J, "k": kVK_ANSI_K, "l": kVK_ANSI_L,
    "m": kVK_ANSI_M, "n": kVK_ANSI_N, "o": kVK_ANSI_O, "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R,
    "s": kVK_ANSI_S, "t": kVK_ANSI_T, "u": kVK_ANSI_U, "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X,
    "y": kVK_ANSI_Y, "z": kVK_ANSI_Z, "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3,
    "4": kVK_ANSI_4, "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9,
]

enum Logos {
    static var app: NSRunningApplication? {
        NSRunningApplication.runningApplications(withBundleIdentifier: logosBundleId).first
    }

    static var isFrontmost: Bool {
        NSWorkspace.shared.frontmostApplication?.bundleIdentifier == logosBundleId
    }

    private static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }

    private static func children(_ element: AXUIElement) -> [AXUIElement] {
        (attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
    }

    /// Edit ▸ Copy, found by its ⌘C key equivalent so the menu language does not matter.
    /// Reading panels are custom-drawn and expose no AXSelectedText, so the menu is the only way in.
    static func copyMenuItem() -> AXUIElement? {
        guard let app else { return nil }
        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        guard let bar = attribute(axApp, kAXMenuBarAttribute) else { return nil }
        for barItem in children(bar as! AXUIElement) {
            for menu in children(barItem) {
                for item in children(menu) {
                    let char = attribute(item, kAXMenuItemCmdCharAttribute) as? String
                    let modifiers = attribute(item, kAXMenuItemCmdModifiersAttribute) as? Int
                    if char?.uppercased() == "C" && modifiers == 0 { return item }
                }
            }
        }
        return nil
    }

    /// What the reference box of each open book panel shows ("Page 5", "Jn 3:16").
    /// Found through each panel's toolbar (AXGroup titled "Book Toolbar"); the
    /// box is its first static text.
    static func openPanelReferences() -> Set<String> {
        guard let app else { return [] }
        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        var references = Set<String>()
        var budget = 5000

        func text(_ element: AXUIElement) -> String? {
            for name in [kAXValueAttribute, kAXTitleAttribute] {
                if let value = attribute(element, name) as? String, !value.isEmpty { return value }
            }
            return nil
        }
        func firstStaticText(_ element: AXUIElement, depth: Int) -> String? {
            for child in children(element) {
                if attribute(child, kAXRoleAttribute) as? String == kAXStaticTextRole, let value = text(child) {
                    return value
                }
                if depth < 8, let value = firstStaticText(child, depth: depth + 1) { return value }
            }
            return nil
        }
        func walk(_ element: AXUIElement, depth: Int) {
            budget -= 1
            guard budget > 0, depth < 30 else { return }
            if attribute(element, kAXTitleAttribute) as? String == "Book Toolbar" {
                if let reference = firstStaticText(element, depth: 0) { references.insert(reference) }
                return
            }
            children(element).forEach { walk($0, depth: depth + 1) }
        }
        for window in (attribute(axApp, kAXWindowsAttribute) as? [AXUIElement]) ?? [] { walk(window, depth: 0) }
        return references
    }

    static func postKey(_ keyCode: Int, flags: CGEventFlags = []) {
        guard let pid = app?.processIdentifier else { return }
        let source = CGEventSource(stateID: .hidSystemState)
        for down in [true, false] {
            let event = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(keyCode), keyDown: down)
            // Explicit flags, so modifiers still held from the hotkey do not leak in.
            event?.flags = flags
            event?.postToPid(pid)
        }
    }

    /// Copies the selection in Logos and reads it, then puts the user's clipboard back.
    /// Nil when nothing was copied (no selection). Blocking — call off the main thread.
    static func captureSelection(timeout: TimeInterval = 1.0) -> Capture? {
        let pb = NSPasteboard.general
        let saved = Clipboard.snapshot(pb)
        let before = pb.changeCount

        let item = copyMenuItem()
        let pressed = item.map { AXUIElementPerformAction($0, kAXPressAction as CFString) == .success } ?? false
        if !pressed { postKey(kVK_ANSI_C, flags: .maskCommand) }

        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if pb.changeCount != before, pb.types?.contains(.string) == true { break }
            usleep(20_000)
        }
        guard pb.changeCount != before else {
            log("nothing copied (Copy menu item \(item == nil ? "not found" : pressed ? "pressed" : "press failed, sent ⌘C"))")
            return nil
        }
        usleep(50_000)  // let Logos finish writing every flavour before reading
        var capture = Clipboard.readCapture(pb)
        Clipboard.restore(pb, saved)
        if var copied = capture, copied.link == nil, let resourceId = copied.resourceId,
           let position = LogosData.position(resourceId: resourceId, offset: copied.absoluteOffset) {
            copied.link = position.link
            copied.label = position.label
            if copied.title == nil { copied.title = position.title }
            capture = copied
        }
        return capture
    }

    /// Presses the Logos highlighter shortcut from config.json while the selection is still live.
    static func highlightSelection() {
        let key = Config.load().highlightKey.lowercased()
        guard !key.isEmpty else { return }
        guard let code = letterKeyCodes[key] else {
            log("highlightKey \"\(key)\" is not a single letter or digit — skipped")
            return
        }
        guard isFrontmost else { return }
        postKey(code)
    }
}

// MARK: - Logos data (read-only SQLite)

let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

enum LogosData {
    /// One folder per signed-in Logos user (e.g. "l2xr2ib5.nbz"); the most recently used wins.
    static func userFolder(_ kind: String) -> URL? {
        let base = logosRoot.appendingPathComponent(kind)
        let keys: [URLResourceKey] = [.contentModificationDateKey, .isDirectoryKey]
        let dirs = (try? FileManager.default.contentsOfDirectory(at: base, includingPropertiesForKeys: keys)) ?? []
        func modified(_ url: URL) -> Date {
            (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
        }
        return dirs.filter { $0.hasDirectoryPath }.max { modified($0) < modified($1) }
    }

    static func query(_ path: URL, _ sql: String, _ args: [String] = []) -> [[String?]] {
        let encoded = path.path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? path.path
        var db: OpaquePointer?
        defer { sqlite3_close(db) }
        guard sqlite3_open_v2("file:\(encoded)?mode=ro", &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, nil) == SQLITE_OK else {
            log("cannot open \(path.lastPathComponent)")
            return []
        }
        sqlite3_busy_timeout(db, 500)
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(stmt) }
        for (index, arg) in args.enumerated() { sqlite3_bind_text(stmt, Int32(index + 1), arg, -1, SQLITE_TRANSIENT) }
        var rows: [[String?]] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            rows.append((0..<sqlite3_column_count(stmt)).map { column in
                sqlite3_column_text(stmt, column).map { String(cString: $0) }
            })
        }
        return rows
    }

    /// ref.ly's short name for a book is its resource file name: LLS:42.110.133 → LW33.logos4 → "lw33".
    static func shortName(_ resourceId: String) -> String? {
        guard let data = userFolder("Data") else { return nil }
        let rows = query(data.appendingPathComponent("ResourceManager/ResourceManager.db"),
                         "select Location from Resources where ResourceId = ? limit 1", [resourceId])
        guard let location = rows.first?.first ?? nil else { return nil }
        return URL(fileURLWithPath: location).deletingPathExtension().lastPathComponent.lowercased()
    }

    struct Position { var link: String; var label: String; var resourceId: String; var title: String? }

    /// The catalog's display title ("Luther’s Works, Volume 33"); the citation's
    /// title follows the citation style instead ("Luther’s works, vol. 33").
    static func catalogTitle(_ resourceId: String) -> String? {
        guard let data = userFolder("Data") else { return nil }
        let rows = query(data.appendingPathComponent("LibraryCatalog/catalog.db"),
                         "select Title from Records where ResourceId = ? limit 1", [resourceId])
        return rows.first?.first ?? nil
    }

    /// The place Logos last recorded for a book that is open right now.
    ///
    /// Logos writes history when you navigate away from a place, not when a book
    /// is opened from the Library or a shortcut, so the newest entry can belong to
    /// the previous book. An entry is only trusted when its page ("Page 5") is what
    /// an open book panel's reference box shows — the one live hint Logos's
    /// Accessibility tree gives, since it never names the book, and Logos only
    /// exposes its panels there some of the time. Nil when nothing matches: a
    /// selection in the book is the reliable way to say which it is.
    static func currentPosition() -> Position? {
        let shown = Logos.openPanelReferences()
        guard !shown.isEmpty else {
            log("no open book panel found — history not trusted")
            return nil
        }
        let rows = historyRows(limit: 20)
        guard let row = rows.first(where: { shown.contains($0.subtitle) }) else {
            log("history does not match the open panels \(shown.sorted()) — not trusted")
            return nil
        }
        return position(row, offset: nil)
    }

    /// A link for a copy that came without Logos's citation — a word or two in a
    /// heading copies as bare text — but still names the book and the absolute
    /// offset of the selection.
    static func position(resourceId: String, offset: Int?) -> Position? {
        let rows = historyRows(limit: 200).filter { $0.fields["Id"] == resourceId }
        if let offset {
            // The nearest page Logos has recorded at or before the selection.
            let anchors = rows.filter { ($0.pageStart ?? Int.max) <= offset }
            if let best = anchors.max(by: { ($0.pageStart ?? 0) < ($1.pageStart ?? 0) }) {
                return position(best, offset: offset)
            }
        }
        if let latest = rows.first { return position(latest, offset: nil) }
        guard let short = shortName(resourceId) else { return nil }
        let title = catalogTitle(resourceId)
        return Position(link: "https://ref.ly/logosres/\(short)", label: title ?? short, resourceId: resourceId, title: title)
    }

    struct HistoryRow {
        var title: String
        var subtitle: String
        /// Resource|Id=LLS:42.110.133|Milestone=DataType%3dpage%7c…StartSegment%3d149872…|Position=res/…/151950|Reference=page.37
        var fields: [String: String]

        var page: String? {
            guard let reference = fields["Reference"], reference.lowercased().hasPrefix("page.") else { return nil }
            return String(reference.dropFirst("page.".count))
        }
        var pageStart: Int? {
            guard page != nil, let milestone = fields["Milestone"] else { return nil }
            for part in milestone.split(separator: "|") where part.hasPrefix("StartSegment=") {
                return Int(part.dropFirst("StartSegment=".count))
            }
            return nil
        }
        var absolutePosition: Int? { fields["Position"]?.split(separator: "/").last.flatMap { Int($0) } }
    }

    static func historyRows(limit: Int) -> [HistoryRow] {
        guard let data = userFolder("Data") else { return [] }
        let rows = query(data.appendingPathComponent("HistoryManager/history.db"),
                         "select Title, Subtitle, Bookmark from History where IsDeleted = 0 and Bookmark like 'Resource|%' order by LastVisited desc limit \(limit)")
        return rows.compactMap { row in
            guard let bookmark = row[2] else { return nil }
            var fields: [String: String] = [:]
            for part in bookmark.split(separator: "|").dropFirst() {
                let pair = part.split(separator: "=", maxSplits: 1).map(String.init)
                if pair.count == 2 { fields[pair[0]] = pair[1].removingPercentEncoding ?? pair[1] }
            }
            return HistoryRow(title: row[0] ?? "", subtitle: row[1] ?? "", fields: fields)
        }
    }

    /// A page-anchored link like Logos's own "Copy link": off = absolute position −
    /// start of the page milestone (verified against a real Logos link). With
    /// `offset`, the link points there instead of at the recorded position; an
    /// offset past the end of the anchor's page has not been checked in Logos.
    private static func position(_ row: HistoryRow, offset: Int?) -> Position? {
        guard let resourceId = row.fields["Id"], let short = shortName(resourceId) else { return nil }
        var link = "https://ref.ly/logosres/\(short)"
        var pageLabel = row.subtitle
        if let page = row.page, let start = row.pageStart, let target = offset ?? row.absolutePosition {
            let encodedPage = page.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? page
            link += "?ref=Page.p+\(encodedPage)&off=\(max(0, target - start))"
            pageLabel = "p. \(page)"
        }
        let title = catalogTitle(resourceId) ?? row.title
        let label = [title, pageLabel].filter { !$0.isEmpty }.joined(separator: ", ")
        return Position(link: link, label: label.isEmpty ? short : label, resourceId: resourceId, title: title)
    }
}

/// ref.ly links are web redirects to Logos's own URL scheme; opening the native
/// form skips the browser round trip. The mapping is what ref.ly's redirect does:
/// https://ref.ly/logosres/lw33?ref=Page.p+37&off=2078 → logosres:lw33;ref=Page.p_37;off=2078
func nativeLogosURL(_ link: String) -> URL? {
    if link.hasPrefix("logosres:") { return URL(string: link) }
    guard let components = URLComponents(string: link), components.host == "ref.ly",
          components.path.hasPrefix("/logosres/") else { return nil }
    let name = components.path.dropFirst("/logosres/".count)
    let params = (components.percentEncodedQuery ?? "").split(separator: "&").map {
        $0.replacingOccurrences(of: "+", with: "_").replacingOccurrences(of: "%", with: "$")
    }
    return URL(string: "logosres:\(name)" + params.map { ";" + $0 }.joined())
}

// MARK: - HTTP bridge (the plugin long-polls it)

final class Bridge {
    static let shared = Bridge()

    private let queue = DispatchQueue(label: "logos-bridge")
    private var listener: NWListener?
    private var jobs: [Job] = []
    private var deliveredAt: [String: Date] = [:]
    private var waiters: [(conn: NWConnection, origin: String?, timeout: DispatchWorkItem)] = []
    private var lastPoll: Date?
    /// Answers the plugin owes, keyed by the id of the job that asked.
    private var contextHandlers: [String: (Context?) -> Void] = [:]

    /// A delivered job the plugin never acknowledged (reload mid-job, dropped
    /// connection) goes out again after this long.
    private let redeliverAfter: TimeInterval = 60

    var isConnected: Bool {
        queue.sync { !waiters.isEmpty || (lastPoll.map { Date().timeIntervalSince($0) < 40 } ?? false) }
    }

    func start(port: UInt16) {
        do {
            let listener = try NWListener(using: .tcp, on: NWEndpoint.Port(rawValue: port)!)
            listener.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
            listener.stateUpdateHandler = { state in
                if case .failed(let error) = state {
                    log("listener failed: \(error)")
                    exit(1)  // launchd restarts us
                }
            }
            listener.start(queue: queue)
            self.listener = listener
            log("listening on 127.0.0.1:\(port)")
        } catch {
            log("cannot listen on \(port): \(error)")
            exit(1)
        }
    }

    func enqueue(_ job: Job) {
        queue.async {
            self.jobs.append(job)
            self.flushWaiters()
        }
    }

    /// Asks the plugin a question that the helper waits on: "context" (where an
    /// extract would go right now — the focused Rem can change at any time, so it
    /// is asked per extract rather than pushed) or "lookupBook" (is this book
    /// already in the KB). `completion` runs on the main thread: with nil once
    /// `timeout` passes, and again with the answer if it arrives later.
    func ask(_ job: Job, timeout: TimeInterval, _ completion: @escaping (Context?) -> Void) {
        var answered = false
        let finish: (Context?) -> Void = { context in
            guard !answered else { return }
            if context != nil { answered = true }
            completion(context)
        }
        queue.async {
            self.contextHandlers[job.id] = finish
            self.jobs.append(job)
            self.flushWaiters()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { finish(nil) }
    }

    // Everything below runs on `queue`.

    private func accept(_ conn: NWConnection) {
        guard Self.isLoopback(conn.endpoint) else {
            conn.cancel()
            return
        }
        conn.start(queue: queue)
        receive(conn, Data())
    }

    private static func isLoopback(_ endpoint: NWEndpoint) -> Bool {
        guard case .hostPort(let host, _) = endpoint else { return false }
        switch host {
        case .ipv4(let address): return address.isLoopback
        case .ipv6(let address): return address.isLoopback || (address.asIPv4?.isLoopback ?? false)
        default: return false
        }
    }

    private func receive(_ conn: NWConnection, _ buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var buffer = buffer
            if let data { buffer.append(data) }
            if let request = Request.parse(buffer) {
                self.route(request, conn)
            } else if isComplete || error != nil || buffer.count > 8 << 20 {
                conn.cancel()
            } else {
                self.receive(conn, buffer)
            }
        }
    }

    private func route(_ request: Request, _ conn: NWConnection) {
        let origin = request.headers["origin"]
        if request.method == "OPTIONS" { return respond(conn, 204) }

        let allowed = Config.load().allowedOrigins
        if !allowed.isEmpty, let origin, !allowed.contains(origin) {
            log("rejected origin \(origin)")
            return respond(conn, 403, json(["ok": false, "error": "origin not allowed: \(origin)"]))
        }

        switch (request.method, request.path) {
        case ("GET", "/"), ("GET", "/ping"):
            respond(conn, 200, json(["ok": true, "version": bridgeVersion, "logosRunning": Logos.app != nil]))

        case ("GET", "/next"):
            lastPoll = Date()
            if let job = nextDeliverable() { return deliver(job, to: conn) }
            let wait = min(max(Double(request.query["wait"] ?? "") ?? 25, 0), 55)
            let timeout = DispatchWorkItem { [weak self] in
                guard let self, let index = self.waiters.firstIndex(where: { $0.conn === conn }) else { return }
                self.waiters.remove(at: index)
                self.respond(conn, 204)
            }
            waiters.append((conn, origin, timeout))
            queue.asyncAfter(deadline: .now() + wait, execute: timeout)
            // Notice a client that gave up (RemNote reloaded), so no job is handed to a dead socket.
            conn.receive(minimumIncompleteLength: 1, maximumLength: 1) { [weak self] _, _, isComplete, error in
                guard isComplete || error != nil, let self,
                      let index = self.waiters.firstIndex(where: { $0.conn === conn }) else { return }
                self.waiters[index].timeout.cancel()
                self.waiters.remove(at: index)
                conn.cancel()
            }

        case ("POST", "/context"):
            let context = try? JSONDecoder().decode(Context.self, from: request.body)
            if let jobId = context?.forJob, let handler = contextHandlers.removeValue(forKey: jobId) {
                DispatchQueue.main.async { handler(context) }
            }
            respond(conn, 200, json(["ok": true]))

        case ("POST", "/result"):
            let body = (try? JSONSerialization.jsonObject(with: request.body)) as? [String: Any] ?? [:]
            let ok = body["ok"] as? Bool ?? false
            var finished: Job?
            if let jobId = body["jobId"] as? String {
                finished = jobs.first { $0.id == jobId }
                jobs.removeAll { $0.id == jobId }
                deliveredAt[jobId] = nil
            }
            // The plugin has opened the new book IncRem; a plugin cannot activate its own app.
            if ok, finished?.type == "newBook" {
                DispatchQueue.main.async { activateRemNote() }
            }
            let message = body["message"] as? String ?? (ok ? "Done" : "Failed")
            log("result ok=\(ok): \(message)")
            DispatchQueue.main.async { HUD.show(message, ok: ok) }
            respond(conn, 200, json(["ok": true]))

        case ("POST", "/open"):
            let body = (try? JSONSerialization.jsonObject(with: request.body)) as? [String: Any] ?? [:]
            // Only Logos links: anything on this machine can reach the port.
            guard let link = body["url"] as? String, let url = nativeLogosURL(link) else {
                return respond(conn, 400, json(["ok": false, "error": "not a Logos link"]))
            }
            DispatchQueue.main.async { NSWorkspace.shared.open(url) }
            respond(conn, 200, json(["ok": true, "opened": url.absoluteString]))

        default:
            respond(conn, 404, json(["ok": false, "error": "unknown route"]))
        }
    }

    private func nextDeliverable() -> Job? {
        let now = Date()
        return jobs.first { job in
            guard let at = deliveredAt[job.id] else { return true }
            return now.timeIntervalSince(at) > redeliverAfter
        }
    }

    private func deliver(_ job: Job, to conn: NWConnection) {
        if job.type == "context" || job.type == "lookupBook" {
            jobs.removeAll { $0.id == job.id }  // answered by POST /context, never acknowledged
        } else {
            deliveredAt[job.id] = Date()
        }
        respond(conn, 200, (try? JSONEncoder().encode(job)) ?? Data())
    }

    private func flushWaiters() {
        while !waiters.isEmpty, let job = nextDeliverable() {
            let waiter = waiters.removeFirst()
            waiter.timeout.cancel()
            deliver(job, to: waiter.conn)
        }
    }

    private func json(_ object: [String: Any]) -> Data {
        (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
    }

    private func respond(_ conn: NWConnection, _ status: Int, _ body: Data = Data()) {
        let reasons = [200: "OK", 204: "No Content", 400: "Bad Request", 403: "Forbidden", 404: "Not Found"]
        var head = "HTTP/1.1 \(status) \(reasons[status] ?? "OK")\r\n"
        head += "Access-Control-Allow-Origin: *\r\n"
        head += "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
        head += "Access-Control-Allow-Headers: Content-Type\r\n"
        // Chromium's Private Network Access preflight for requests into localhost.
        head += "Access-Control-Allow-Private-Network: true\r\n"
        head += "Content-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        conn.send(content: Data(head.utf8) + body, completion: .contentProcessed { _ in conn.cancel() })
    }
}

struct Request {
    var method: String
    var path: String
    var query: [String: String]
    var headers: [String: String]
    var body: Data

    /// Nil until the headers and the whole Content-Length body have arrived.
    static func parse(_ data: Data) -> Request? {
        guard let headerEnd = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        var lines = String(decoding: data[..<headerEnd.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
        let requestLine = lines.removeFirst().split(separator: " ")
        guard requestLine.count >= 2 else { return nil }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let length = Int(headers["content-length"] ?? "") ?? 0
        let bodyStart = headerEnd.upperBound
        guard data.count - bodyStart >= length else { return nil }
        let target = String(requestLine[1])
        let components = URLComponents(string: target)
        var query: [String: String] = [:]
        for item in components?.queryItems ?? [] { query[item.name] = item.value ?? "" }
        return Request(method: String(requestLine[0]), path: components?.path ?? target, query: query,
                       headers: headers, body: data.subdata(in: bodyStart..<(bodyStart + length)))
    }
}

// MARK: - HUD (a transient message over Logos)

enum HUD {
    private static var panel: NSPanel?

    static func show(_ text: String, ok: Bool = true) {
        panel?.orderOut(nil)
        let message = text.count > 110 ? String(text.prefix(107)) + "…" : text
        let view = Text((ok ? "✓  " : "⚠︎  ") + message)
            .font(.system(size: 13, weight: .medium))
            .padding(.horizontal, 16).padding(.vertical, 10)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
            .fixedSize()
        let host = NSHostingView(rootView: view)
        let hud = NSPanel(contentRect: NSRect(origin: .zero, size: host.fittingSize),
                          styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        hud.isOpaque = false
        hud.backgroundColor = .clear
        hud.hasShadow = true
        hud.level = .statusBar
        hud.ignoresMouseEvents = true
        hud.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        hud.contentView = host
        if let frame = screenUnderMouse()?.visibleFrame {
            hud.setFrameOrigin(NSPoint(x: frame.midX - hud.frame.width / 2, y: frame.maxY - hud.frame.height - 60))
        }
        hud.orderFrontRegardless()
        panel = hud
        DispatchQueue.main.asyncAfter(deadline: .now() + (ok ? 2.2 : 4.5)) {
            if panel === hud {
                hud.orderOut(nil)
                panel = nil
            }
        }
    }
}

func activateRemNote() {
    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: remNoteBundleId) else {
        log("RemNote.app not found")
        return
    }
    NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
}

func screenUnderMouse() -> NSScreen? {
    NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) } ?? NSScreen.main
}

// MARK: - Extract panel (floats over Logos without taking focus from it)

final class ExtractModel: ObservableObject {
    enum Field: Hashable { case priority, interval }

    let capture: Capture
    let heading: String
    /// Shown instead of asking RemNote for a target (new book IncRems are always top-level).
    let fixedTarget: String?
    /// ⌘↩ = a plain child that is not incremental; extracts only.
    let allowsPlain: Bool
    @Published var context: Context?
    @Published var waiting: Bool
    @Published var priority = ""
    @Published var interval = ""
    @Published var field: Field = .priority

    var onSubmit: (_ incremental: Bool) -> Void = { _ in }
    var onCancel: () -> Void = {}

    init(capture: Capture, heading: String = "Extract to RemNote", fixedTarget: String? = nil, allowsPlain: Bool = true) {
        self.capture = capture
        self.heading = heading
        self.fixedTarget = fixedTarget
        self.allowsPlain = allowsPlain
        waiting = fixedTarget == nil
    }

    /// Nil = no answer yet: the fields stay empty, which the plugin reads as
    /// "inherited priority, default interval". A later answer fills them in.
    func apply(_ context: Context?) {
        waiting = false
        guard let context else { return }
        self.context = context
        if priority.isEmpty, let value = context.defaultPriority { priority = String(value) }
        if interval.isEmpty, let value = context.defaultInterval { interval = String(value) }
    }

    func adjust(by step: Int) {
        switch field {
        case .priority: priority = String(min(max((Int(priority) ?? context?.defaultPriority ?? 10) + step, 0), 100))
        case .interval: interval = String(min(max((Int(interval) ?? context?.defaultInterval ?? 1) + step, 0), 3650))
        }
    }
}

struct ExtractView: View {
    @ObservedObject var model: ExtractModel
    @FocusState private var focus: ExtractModel.Field?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(model.heading).font(.headline)
                Spacer()
                if model.waiting { ProgressView().controlSize(.small) }
            }
            target
            Text(model.capture.preview)
                .font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(4)
            if let label = model.capture.label {
                Text("📖 " + label).font(.caption).foregroundStyle(.tertiary).lineLimit(1)
            }
            HStack(alignment: .top, spacing: 18) {
                numberField("Priority", hint: "0–100 · lower = more important",
                            placeholder: model.fixedTarget == nil ? "inherited" : "default",
                            text: $model.priority, field: .priority)
                numberField("Interval", hint: "days", placeholder: "default", text: $model.interval, field: .interval)
            }
            Spacer(minLength: 0)
            Divider()
            Text(model.allowsPlain
                 ? "↑↓ adjust (⇧ ±10) · Tab switch · ↩ extract · ⌘↩ plain child (not incremental) · Esc cancel"
                 : "↑↓ adjust (⇧ ±10) · Tab switch · ↩ create · Esc cancel")
                .font(.caption2).foregroundStyle(.secondary)
        }
        .padding(16)
        .frame(width: 480, height: 270, alignment: .topLeading)
        .onAppear { DispatchQueue.main.async { focus = model.field } }
        .onChange(of: model.field) { _, field in focus = field }
        .onChange(of: focus) { _, field in if let field { model.field = field } }
    }

    @ViewBuilder private var target: some View {
        if let fixed = model.fixedTarget {
            Text("→ " + fixed).font(.callout).lineLimit(1)
        } else if model.waiting {
            Text("Asking RemNote where to put it…").font(.callout).foregroundStyle(.secondary)
        } else if model.context == nil {
            Text("RemNote has not answered yet — the extract goes under the IncRem under review when it does.")
                .font(.callout).foregroundStyle(.secondary).lineLimit(2)
        } else if let context = model.context, context.targetId != nil {
            HStack(spacing: 6) {
                Text("→ " + (context.targetTitle ?? "(untitled Rem)")).font(.callout).lineLimit(1)
                if context.targetIsFocused == true && context.incRemId != nil {
                    Text("focused Rem inside the IncRem").font(.caption).foregroundStyle(.secondary)
                }
            }
        } else {
            Text("⚠︎ " + (model.context?.problem ?? "RemNote found no place for the extract."))
                .font(.callout).foregroundStyle(.orange).lineLimit(2)
        }
    }

    private func numberField(_ title: String, hint: String, placeholder: String, text: Binding<String>,
                             field: ExtractModel.Field) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(title).font(.caption).bold()
                Text(hint).font(.caption2).foregroundStyle(.secondary)
            }
            TextField(placeholder, text: text)
                .textFieldStyle(.roundedBorder)
                .frame(width: 150)
                .focused($focus, equals: field)
                .onChange(of: text.wrappedValue) { _, value in
                    let digits = value.filter(\.isNumber)
                    if digits != value { text.wrappedValue = digits }
                }
        }
    }
}

final class FloatingPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

final class ExtractPanel {
    private static var current: ExtractPanel?

    private let panel: FloatingPanel
    private var monitor: Any?

    private init(model: ExtractModel) {
        panel = FloatingPanel(contentRect: NSRect(x: 0, y: 0, width: 480, height: 270),
                              styleMask: [.nonactivatingPanel, .titled, .fullSizeContentView],
                              backing: .buffered, defer: false)
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        for button in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            panel.standardWindowButton(button)?.isHidden = true
        }
        panel.contentView = NSHostingView(rootView: ExtractView(model: model))

        // Keys are taken before the text field sees them: its field editor would
        // otherwise swallow ↑↓ and Return.
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self, weak model] event in
            guard let self, let model, event.window === self.panel else { return event }
            let shift = event.modifierFlags.contains(.shift)
            switch Int(event.keyCode) {
            case kVK_UpArrow: model.adjust(by: shift ? 10 : 1); return nil
            case kVK_DownArrow: model.adjust(by: shift ? -10 : -1); return nil
            case kVK_Tab: model.field = model.field == .priority ? .interval : .priority; return nil
            case kVK_Return, kVK_ANSI_KeypadEnter:
                model.onSubmit(!(model.allowsPlain && event.modifierFlags.contains(.command)))
                return nil
            case kVK_Escape: model.onCancel(); return nil
            default: return event
            }
        }
    }

    static func show(_ model: ExtractModel) {
        current?.close()
        let controller = ExtractPanel(model: model)
        current = controller
        if let frame = screenUnderMouse()?.visibleFrame {
            let size = controller.panel.frame.size
            controller.panel.setFrameOrigin(NSPoint(x: frame.midX - size.width / 2, y: frame.maxY - frame.height / 3 - size.height / 2))
        }
        // Non-activating: Logos stays the active app and keeps its selection,
        // so the highlighter key can still be applied after the panel closes.
        controller.panel.makeKeyAndOrderFront(nil)
    }

    static func closeCurrent() {
        current?.close()
        current = nil
    }

    private func close() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        panel.orderOut(nil)
    }
}

// MARK: - Actions

/// Without Accessibility, macOS drops both the Edit ▸ Copy press and the posted
/// ⌘C without an error, which would look like "nothing selected". Say so instead.
/// An ad-hoc signed rebuild is a new app to macOS, so this recurs after every
/// rebuild unless build.sh signs with a stable certificate.
func ensureAccessibility() -> Bool {
    if AXIsProcessTrusted() { return true }
    log("hotkey ignored: Accessibility not granted")
    HUD.show("LogosBridge needs Accessibility — remove it from the list, then add it again", ok: false)
    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
        NSWorkspace.shared.open(url)
    }
    return false
}

enum Actions {
    static func extract(quick: Bool) {
        guard Logos.isFrontmost, ensureAccessibility() else { return }
        DispatchQueue.global(qos: .userInitiated).async {
            let capture = Logos.captureSelection()
            DispatchQueue.main.async {
                guard let capture else {
                    HUD.show("Select a passage in Logos first", ok: false)
                    return
                }
                quick ? quickExtract(capture) : openPanel(capture)
            }
        }
    }

    /// No panel: the plugin picks the target and uses the inherited priority and default interval.
    private static func quickExtract(_ capture: Capture) {
        Bridge.shared.enqueue(Job(type: "extract", capture: capture, incremental: true))
        Logos.highlightSelection()
        if !Bridge.shared.isConnected { HUD.show("Queued — RemNote is not connected yet", ok: false) }
    }

    private static func openPanel(_ capture: Capture) {
        let model = ExtractModel(capture: capture)
        model.onCancel = { ExtractPanel.closeCurrent() }
        model.onSubmit = { [weak model] incremental in
            guard let model else { return }
            var job = Job(type: "extract", targetId: model.context?.targetId, capture: capture, incremental: incremental)
            if incremental {
                job.priority = Int(model.priority)
                job.interval = Int(model.interval)
            }
            Bridge.shared.enqueue(job)
            ExtractPanel.closeCurrent()
            // Give Logos its key window back before the highlighter key reaches it.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { Logos.highlightSelection() }
        }
        ExtractPanel.show(model)
        if Bridge.shared.isConnected {
            Bridge.shared.ask(Job(type: "context"), timeout: 2.0) { model.apply($0) }
        } else {
            model.apply(Context(problem: "RemNote is not connected (Logos bridge setting off, or RemNote closed). The extract will wait until it connects."))
        }
    }

    /// ⌃⌥N: an IncRem for the open book. The position comes from the selection when
    /// there is one, else from Logos's history; the plugin puts the Rem at the top
    /// level, tags it #Logos, and reuses an existing one for the same book.
    static func newBook() {
        guard Logos.isFrontmost, ensureAccessibility() else { return }
        DispatchQueue.global(qos: .userInitiated).async {
            var job = Job(type: "newBook")
            if let capture = Logos.captureSelection(timeout: 0.6), let link = capture.link {
                job.link = link
                job.label = capture.label
                job.resourceId = capture.resourceId
                job.title = capture.resourceId.flatMap(LogosData.catalogTitle) ?? capture.title
            } else if let position = LogosData.currentPosition() {
                job.link = position.link
                job.label = position.label
                job.resourceId = position.resourceId
                job.title = LogosData.catalogTitle(position.resourceId) ?? position.title
            }
            DispatchQueue.main.async {
                guard job.link != nil, let title = job.title else {
                    HUD.show("Select a word in the book first — Logos has not recorded which book is open", ok: false)
                    return
                }
                guard Bridge.shared.isConnected else { return showNewBookPanel(job, title: title) }
                // Already imported? RemNote opens the existing IncRem instead of making a second one.
                var lookup = Job(type: "lookupBook")
                lookup.resourceId = job.resourceId
                lookup.title = title
                var panelShown = false
                Bridge.shared.ask(lookup, timeout: 2.0) { answer in
                    if let existing = answer?.existingBookId, !existing.isEmpty {
                        if panelShown { ExtractPanel.closeCurrent() }
                        activateRemNote()
                        HUD.show("“\(answer?.existingBookTitle ?? title)” is already in your RemNote KB — opened it")
                    } else if !panelShown {
                        panelShown = true
                        showNewBookPanel(job, title: title)
                    }
                }
            }
        }
    }

    private static func showNewBookPanel(_ job: Job, title: String) {
        var job = job
        let model = ExtractModel(capture: Capture(segments: [Segment(text: title)], plain: title, label: job.label),
                                 heading: "New IncRem for this book",
                                 fixedTarget: "new top-level Rem tagged #Logos", allowsPlain: false)
        model.onCancel = { ExtractPanel.closeCurrent() }
        model.onSubmit = { [weak model] _ in
            guard let model else { return }
            job.priority = Int(model.priority)
            job.interval = Int(model.interval)
            Bridge.shared.enqueue(job)
            ExtractPanel.closeCurrent()
            if !Bridge.shared.isConnected { HUD.show("Queued — RemNote is not connected yet", ok: false) }
        }
        ExtractPanel.show(model)
    }

    static func bookmark() {
        guard Logos.isFrontmost, ensureAccessibility() else { return }
        DispatchQueue.global(qos: .userInitiated).async {
            var link: String?
            var label: String?
            if let capture = Logos.captureSelection(timeout: 0.6), let captured = capture.link {
                link = captured
                label = capture.label
            } else if let position = LogosData.currentPosition() {
                link = position.link
                label = position.label
            }
            DispatchQueue.main.async {
                guard let link else {
                    HUD.show("Select a word in the book first — Logos has not recorded which book is open", ok: false)
                    return
                }
                Bridge.shared.enqueue(Job(type: "bookmark", link: link, label: label))
                if !Bridge.shared.isConnected { HUD.show("Bookmark queued — RemNote is not connected yet", ok: false) }
            }
        }
    }
}

// MARK: - Hotkeys (registered only while Logos is frontmost)

final class HotKeys {
    struct Binding {
        let id: UInt32
        let keyCode: Int
        let modifiers: Int
        let action: () -> Void
    }

    static let shared = HotKeys()
    private var bindings: [Binding] = []
    private var refs: [EventHotKeyRef] = []

    func install(_ bindings: [Binding]) {
        self.bindings = bindings
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
            var hotKey = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                              nil, MemoryLayout<EventHotKeyID>.size, nil, &hotKey)
            HotKeys.shared.fire(hotKey.id)
            return noErr
        }, 1, &spec, nil, nil)
    }

    private func fire(_ id: UInt32) {
        bindings.first { $0.id == id }?.action()
    }

    /// Registered only while Logos is in front, so the combos stay free everywhere else.
    func setActive(_ active: Bool) {
        if active, refs.isEmpty {
            for binding in bindings {
                var ref: EventHotKeyRef?
                let id = EventHotKeyID(signature: OSType(0x4C4F_4742), id: binding.id)  // 'LOGB'
                let status = RegisterEventHotKey(UInt32(binding.keyCode), UInt32(binding.modifiers), id,
                                                 GetApplicationEventTarget(), 0, &ref)
                if status == noErr, let ref { refs.append(ref) } else { log("hotkey \(binding.id) not registered: \(status)") }
            }
        } else if !active, !refs.isEmpty {
            refs.forEach { UnregisterEventHotKey($0) }
            refs.removeAll()
        }
    }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        let prompt = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        let trusted = AXIsProcessTrustedWithOptions([prompt: true] as CFDictionary)
        log("LogosBridge \(bridgeVersion) starting — Accessibility \(trusted ? "granted" : "NOT granted (System Settings ▸ Privacy & Security ▸ Accessibility)")")

        Bridge.shared.start(port: Config.load().port)

        let ctrlOpt = controlKey | optionKey
        HotKeys.shared.install([
            .init(id: 1, keyCode: kVK_ANSI_X, modifiers: ctrlOpt) { Actions.extract(quick: false) },
            .init(id: 2, keyCode: kVK_ANSI_X, modifiers: ctrlOpt | shiftKey) { Actions.extract(quick: true) },
            .init(id: 3, keyCode: kVK_ANSI_B, modifiers: ctrlOpt) { Actions.bookmark() },
            .init(id: 4, keyCode: kVK_ANSI_N, modifiers: ctrlOpt) { Actions.newBook() },
        ])
        HotKeys.shared.setActive(Logos.isFrontmost)
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { note in
            let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            HotKeys.shared.setActive(app?.bundleIdentifier == logosBundleId)
        }
    }
}

// Diagnostics: `LogosBridge --dump-clipboard` parses a Logos copy already on the
// clipboard; `--capture` copies the selection in Logos the way the hotkeys do
// (clipboard restored); `--position` prints the bookmark ⌃⌥B would fall back to.
if CommandLine.arguments.contains("--capture") {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    let capture = Logos.captureSelection()
    print(capture.flatMap { String(data: try! encoder.encode($0), encoding: .utf8) } ?? "nothing copied")
    exit(0)
}
if CommandLine.arguments.contains("--dump-clipboard") || CommandLine.arguments.contains("--position") {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    if CommandLine.arguments.contains("--dump-clipboard") {
        let capture = Clipboard.readCapture(NSPasteboard.general)
        print(capture.flatMap { String(data: try! encoder.encode($0), encoding: .utf8) } ?? "no Logos text on the clipboard")
        if let link = capture?.link { print("native:", nativeLogosURL(link)?.absoluteString ?? "-") }
    }
    if CommandLine.arguments.contains("--position") {
        let position = LogosData.currentPosition()
        print(position.map { "\($0.label)\n\($0.link)\nnative: \(nativeLogosURL($0.link)?.absoluteString ?? "-")" } ?? "no position")
    }
    exit(0)
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.run()
