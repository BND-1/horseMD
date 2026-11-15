import Foundation
import UIKit
import UniformTypeIdentifiers
import Capacitor

/// HorseFiles: open and edit Markdown files and folders that live outside the
/// app (Files app, iCloud Drive, other file providers) in place, and keep
/// access across restarts with security-scoped bookmarks.
///
/// A "root" is one thing the user granted: a single file or a folder. Every
/// operation starts security-scoped access on the ROOT url (a folder grant
/// covers everything inside it) and goes through NSFileCoordinator so file
/// providers (iCloud Drive, ...) see our reads and writes.
@objc(HorseFilesPlugin)
public class HorseFilesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HorseFilesPlugin"
    public let jsName = "HorseFiles"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pickFiles", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "adopt", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "roots", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forget", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stat", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "create", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "mkdir", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "move", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pendingIncoming", returnType: CAPPluginReturnPromise)
    ]

    // MARK: - Incoming files (static: AppDelegate can receive a file before the plugin exists)

    private static let incomingEvent = "incoming"
    private static let incomingLock = NSLock()
    private static var incomingQueue: [[String: Any]] = []
    /// The URL objects iOS handed us, by absoluteString. An open-in-place URL
    /// carries its sandbox extension inside the URL object; a URL rebuilt from
    /// the string JS sends back to `adopt` would not be accessible.
    private static var incomingURLs: [String: URL] = [:]
    private static weak var live: HorseFilesPlugin?

    /// Called from AppDelegate.application(_:open:options:) for file URLs.
    /// Notifies the live plugin when JS listens, otherwise queues the item for
    /// `pendingIncoming` (never both, so one file is delivered once).
    static func receiveIncoming(_ url: URL, inPlace: Bool) {
        let key = url.absoluteString
        let item: [String: Any] = ["url": key, "inPlace": inPlace]
        incomingLock.lock()
        incomingURLs[key] = url
        let plugin = live
        if let plugin = plugin, plugin.hasListeners(incomingEvent) {
            incomingLock.unlock()
            plugin.notifyListeners(incomingEvent, data: item, retainUntilConsumed: true)
            return
        }
        if !incomingQueue.contains(where: { ($0["url"] as? String) == key }) {
            incomingQueue.append(item)
        }
        incomingLock.unlock()
    }

    private static func drainIncoming() -> [[String: Any]] {
        incomingLock.lock()
        defer { incomingLock.unlock() }
        let items = incomingQueue
        incomingQueue.removeAll()
        return items
    }

    private static func takeIncomingURL(_ key: String) -> URL? {
        incomingLock.lock()
        defer { incomingLock.unlock() }
        return incomingURLs.removeValue(forKey: key)
    }

    // MARK: - State

    private enum Kind: String, Codable {
        case file
        case folder
    }

    /// What we persist per root in UserDefaults (`horsefiles.roots`).
    private struct StoredRoot: Codable {
        var id: String
        var kind: Kind
        var name: String
        var bookmark: Data
        var writable: Bool
    }

    /// A root we could not make a bookmark for: valid while the process lives.
    private struct TransientRoot {
        var id: String
        var kind: Kind
        var name: String
        var url: URL
        var writable: Bool
    }

    private struct RootHandle {
        var kind: Kind
        var url: URL
        var cached: Bool
    }

    private static let storeKey = "horsefiles.roots"

    /// All file work runs here: NSFileCoordinator blocks, and the bridge's own
    /// queue is shared by every plugin.
    private let workQueue = DispatchQueue(label: "com.horsemd.horsefiles")
    // The members below are touched on workQueue only.
    private var stored: [StoredRoot] = []
    private var transient: [TransientRoot] = []
    private var resolvedURLs: [String: URL] = [:]

    // Touched on the main thread only.
    private var activePicker: PickerDelegate?

    override public func load() {
        HorseFilesPlugin.live = self
        workQueue.async {
            self.stored = HorseFilesPlugin.loadStore()
        }
    }

    /// Items that arrive between `pendingIncoming` and the listener registering
    /// are delivered as soon as the listener exists.
    override public func addListener(_ call: CAPPluginCall) {
        super.addListener(call)
        guard call.getString("eventName") == HorseFilesPlugin.incomingEvent else { return }
        for item in HorseFilesPlugin.drainIncoming() {
            notifyListeners(HorseFilesPlugin.incomingEvent, data: item, retainUntilConsumed: true)
        }
    }

    // MARK: - Errors

    struct HFError: Error {
        let code: String
        let message: String
        static func inval(_ message: String) -> HFError { HFError(code: "EINVAL", message: message) }
        static func noent(_ message: String) -> HFError { HFError(code: "ENOENT", message: message) }
        static func exist(_ message: String) -> HFError { HFError(code: "EEXIST", message: message) }
        static func access(_ message: String) -> HFError { HFError(code: "EACCES", message: message) }
        static func io(_ message: String) -> HFError { HFError(code: "EIO", message: message) }
    }

    private static func posixCode(_ error: NSError) -> Int? {
        if error.domain == NSPOSIXErrorDomain { return error.code }
        if let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError {
            return posixCode(underlying)
        }
        return nil
    }

    private static func mapError(_ error: Error) -> HFError {
        if let hf = error as? HFError { return hf }
        let ns = error as NSError
        let message = ns.localizedDescription
        if ns.domain == NSCocoaErrorDomain {
            switch ns.code {
            case NSFileNoSuchFileError, NSFileReadNoSuchFileError:
                return HFError(code: "ENOENT", message: message)
            case NSFileWriteFileExistsError:
                return HFError(code: "EEXIST", message: message)
            case NSFileReadNoPermissionError, NSFileWriteNoPermissionError, NSFileWriteVolumeReadOnlyError:
                return HFError(code: "EACCES", message: message)
            default:
                break
            }
        }
        if let code = posixCode(ns) {
            switch Int32(code) {
            case ENOENT: return HFError(code: "ENOENT", message: message)
            case EEXIST, ENOTEMPTY: return HFError(code: "EEXIST", message: message)
            case EACCES, EPERM, EROFS: return HFError(code: "EACCES", message: message)
            case EXDEV: return HFError(code: "EXDEV", message: message)
            case ENOTDIR, EISDIR, EINVAL: return HFError(code: "EINVAL", message: message)
            default: break
            }
        }
        return HFError(code: "EIO", message: message)
    }

    /// Runs `body` on the work queue; resolves its result or rejects with a code.
    private func run(_ call: CAPPluginCall, _ body: @escaping () throws -> [String: Any]) {
        workQueue.async {
            do {
                call.resolve(try body())
            } catch {
                let hf = HorseFilesPlugin.mapError(error)
                call.reject(hf.message, hf.code)
            }
        }
    }

    // MARK: - Store

    private static func loadStore() -> [StoredRoot] {
        guard let data = UserDefaults.standard.data(forKey: storeKey) else { return [] }
        return (try? JSONDecoder().decode([StoredRoot].self, from: data)) ?? []
    }

    private func saveStore() {
        if let data = try? JSONEncoder().encode(stored) {
            UserDefaults.standard.set(data, forKey: HorseFilesPlugin.storeKey)
        }
    }

    private func newId() -> String {
        let alphabet = Array("abcdefghijklmnopqrstuvwxyz0123456789")
        while true {
            let id = String((0..<10).map { _ in alphabet.randomElement()! })
            if !stored.contains(where: { $0.id == id }) && !transient.contains(where: { $0.id == id }) {
                return id
            }
        }
    }

    private func rootJSON(id: String, kind: Kind, name: String, writable: Bool, persistent: Bool, accessible: Bool) -> [String: Any] {
        return ["id": id, "kind": kind.rawValue, "name": name, "writable": writable,
                "persistent": persistent, "accessible": accessible]
    }

    /// Resolves a stored root's bookmark. A stale bookmark is re-created and
    /// saved; the name follows the item (a moved / renamed file keeps working).
    private func resolveStored(_ index: Int) throws -> URL {
        var root = stored[index]
        var stale = false
        let url: URL
        do {
            url = try URL(resolvingBookmarkData: root.bookmark, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
        } catch {
            resolvedURLs.removeValue(forKey: root.id)
            throw HFError.access("Access to \(root.name) was lost: \((error as NSError).localizedDescription)")
        }
        // A bookmark follows its item into the trash (Files' 最近删除 is a
        // .Trash folder): writing there would silently go to a deleted
        // folder. Treat a trashed or vanished item as lost.
        // Existence is checked inside the security scope (outside it the
        // sandbox may hide the item) and counts an iCloud placeholder
        // (.<name>.icloud, not downloaded yet) as present.
        let scoped = url.startAccessingSecurityScopedResource()
        let present = FileManager.default.fileExists(atPath: url.path)
            || FileManager.default.fileExists(atPath: placeholder(for: url).path)
        if scoped { url.stopAccessingSecurityScopedResource() }
        if url.pathComponents.contains(".Trash") || !present {
            resolvedURLs.removeValue(forKey: root.id)
            throw HFError.access("\(root.name) was deleted or moved somewhere HorseMD cannot reach")
        }
        var changed = false
        if stale {
            let started = url.startAccessingSecurityScopedResource()
            if let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
                root.bookmark = fresh
                changed = true
            }
            if started { url.stopAccessingSecurityScopedResource() }
        }
        let name = url.lastPathComponent
        if !name.isEmpty && name != root.name {
            root.name = name
            changed = true
        }
        if changed {
            stored[index] = root
            saveStore()
        }
        resolvedURLs[root.id] = url
        return url
    }

    private func handle(for id: String, fresh: Bool) throws -> RootHandle {
        if let t = transient.first(where: { $0.id == id }) {
            return RootHandle(kind: t.kind, url: t.url, cached: false)
        }
        guard let index = stored.firstIndex(where: { $0.id == id }) else {
            throw HFError.noent("Unknown root \(id)")
        }
        if !fresh, let url = resolvedURLs[id] {
            return RootHandle(kind: stored[index].kind, url: url, cached: true)
        }
        return RootHandle(kind: stored[index].kind, url: try resolveStored(index), cached: false)
    }

    /// Runs `body` with security-scoped access to the root started. A cached
    /// root url whose item is gone (moved / renamed) is resolved again first.
    private func withRoot<T>(_ id: String?, _ body: (RootHandle) throws -> T) throws -> T {
        guard let id = id, !id.isEmpty else { throw HFError.inval("Missing root id") }
        var root = try handle(for: id, fresh: false)
        var started = root.url.startAccessingSecurityScopedResource()
        if root.cached && !itemPresent(root.url) {
            if started { root.url.stopAccessingSecurityScopedResource() }
            root = try handle(for: id, fresh: true)
            started = root.url.startAccessingSecurityScopedResource()
        }
        defer { if started { root.url.stopAccessingSecurityScopedResource() } }
        return try body(root)
    }

    /// Adds (or refreshes) a root for a url the system granted us.
    private func addRoot(_ url: URL, kind: Kind) -> [String: Any] {
        let started = url.startAccessingSecurityScopedResource()
        defer { if started { url.stopAccessingSecurityScopedResource() } }
        let fm = FileManager.default
        // An iCloud file that is not downloaded yet has no item at its path;
        // the picker granted read + write, so assume writable then.
        let writable = fm.fileExists(atPath: url.path) ? fm.isWritableFile(atPath: url.path) : true
        let name = url.lastPathComponent
        let key = url.standardizedFileURL.resolvingSymlinksInPath().path
        let bookmark = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)

        // The same item picked again: keep its root (fresh grant) instead of a duplicate.
        for index in stored.indices where stored[index].kind == kind {
            let existing = resolvedURLs[stored[index].id] ?? (try? resolveStored(index))
            if let existing = existing, existing.standardizedFileURL.resolvingSymlinksInPath().path == key {
                if let bookmark = bookmark { stored[index].bookmark = bookmark }
                stored[index].name = name
                stored[index].writable = writable
                saveStore()
                resolvedURLs[stored[index].id] = url
                let r = stored[index]
                return rootJSON(id: r.id, kind: r.kind, name: r.name, writable: r.writable, persistent: true, accessible: true)
            }
        }
        if let t = transient.first(where: { $0.kind == kind && $0.url.standardizedFileURL.resolvingSymlinksInPath().path == key }) {
            return rootJSON(id: t.id, kind: t.kind, name: t.name, writable: t.writable, persistent: false, accessible: true)
        }

        let id = newId()
        if let bookmark = bookmark {
            stored.append(StoredRoot(id: id, kind: kind, name: name, bookmark: bookmark, writable: writable))
            saveStore()
            resolvedURLs[id] = url
            return rootJSON(id: id, kind: kind, name: name, writable: writable, persistent: true, accessible: true)
        }
        transient.append(TransientRoot(id: id, kind: kind, name: name, url: url, writable: writable))
        return rootJSON(id: id, kind: kind, name: name, writable: writable, persistent: false, accessible: true)
    }

    // MARK: - Paths

    private func target(_ root: RootHandle, _ rel: String?) throws -> URL {
        if root.kind == .file { return root.url }
        let rel = rel ?? ""
        if rel.isEmpty { return root.url }
        var url = root.url
        for segment in rel.split(separator: "/", omittingEmptySubsequences: false) {
            if segment.isEmpty || segment == ".." || segment == "." {
                throw HFError.inval("Invalid path \(rel)")
            }
            url = url.appendingPathComponent(String(segment), isDirectory: false)
        }
        return url
    }

    private func requireFolder(_ root: RootHandle, _ what: String) throws {
        if root.kind != .folder { throw HFError.inval("\(what) needs a folder root") }
    }

    private func requireRel(_ rel: String?) throws -> String {
        guard let rel = rel, !rel.isEmpty else { throw HFError.inval("Missing path") }
        return rel
    }

    /// `.<name>.icloud`: what an iCloud item that is not downloaded looks like on disk.
    private func placeholder(for url: URL) -> URL {
        return url.deletingLastPathComponent().appendingPathComponent("." + url.lastPathComponent + ".icloud")
    }

    private func itemPresent(_ url: URL) -> Bool {
        let fm = FileManager.default
        return fm.fileExists(atPath: url.path) || fm.fileExists(atPath: placeholder(for: url).path)
    }

    private func isEvicted(_ url: URL) -> Bool {
        let fm = FileManager.default
        return !fm.fileExists(atPath: url.path) && fm.fileExists(atPath: placeholder(for: url).path)
    }

    private func mtimeMs(_ date: Date?) -> Int {
        guard let date = date else { return 0 }
        return Int((date.timeIntervalSince1970 * 1000).rounded(.down))
    }

    private func mtime(of url: URL) -> Int {
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        return mtimeMs(attrs?[.modificationDate] as? Date)
    }

    // MARK: - Coordination

    private func coordinatedRead<T>(_ url: URL, _ body: (URL) throws -> T) throws -> T {
        let coordinator = NSFileCoordinator(filePresenter: nil)
        var coordinationError: NSError?
        var result: Result<T, Error>?
        coordinator.coordinate(readingItemAt: url, options: [], error: &coordinationError) { readURL in
            result = Result(catching: { try body(readURL) })
        }
        if let error = coordinationError { throw error }
        guard let out = result else { throw HFError.io("File coordination failed") }
        return try out.get()
    }

    private func coordinatedWrite<T>(_ url: URL, _ options: NSFileCoordinator.WritingOptions, _ body: (URL) throws -> T) throws -> T {
        let coordinator = NSFileCoordinator(filePresenter: nil)
        var coordinationError: NSError?
        var result: Result<T, Error>?
        coordinator.coordinate(writingItemAt: url, options: options, error: &coordinationError) { writeURL in
            result = Result(catching: { try body(writeURL) })
        }
        if let error = coordinationError { throw error }
        guard let out = result else { throw HFError.io("File coordination failed") }
        return try out.get()
    }

    /// A coordinated read of an iCloud item downloads it (waits until it is here).
    private func ensureDownloaded(_ url: URL) throws {
        if isEvicted(url) {
            try coordinatedRead(url) { _ in () }
        }
    }

    /// Atomic write (temp file + rename, so a failure never leaves a truncated
    /// file). Some providers / single-file grants refuse the rename next to the
    /// file; then write in place. Not for out-of-space errors: an in-place
    /// write would truncate the file there.
    private func writeData(_ data: Data, to url: URL) throws {
        do {
            try data.write(to: url, options: .atomic)
        } catch {
            let ns = error as NSError
            if let code = HorseFilesPlugin.posixCode(ns), Int32(code) == ENOSPC || Int32(code) == EDQUOT || Int32(code) == ENOENT {
                throw error
            }
            if ns.domain == NSCocoaErrorDomain && (ns.code == NSFileWriteOutOfSpaceError || ns.code == NSFileNoSuchFileError) {
                throw error
            }
            try data.write(to: url, options: [])
        }
    }

    // MARK: - Pickers

    private final class PickerDelegate: NSObject, UIDocumentPickerDelegate {
        let done: ([URL]) -> Void
        init(done: @escaping ([URL]) -> Void) { self.done = done }
        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { done(urls) }
        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { done([]) }
    }

    private func presentPicker(_ call: CAPPluginCall, types: [UTType], multiple: Bool, completion: @escaping ([URL]) -> Void) {
        DispatchQueue.main.async {
            guard var top = self.bridge?.viewController else {
                call.reject("No view controller to present the picker", "EIO")
                return
            }
            if self.activePicker != nil {
                call.reject("A picker is already open", "EIO")
                return
            }
            while let presented = top.presentedViewController { top = presented }
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: false)
            picker.allowsMultipleSelection = multiple
            // UIDocumentPickerViewController holds its delegate weakly: keep it until it finishes.
            let delegate = PickerDelegate { [weak self] urls in
                self?.activePicker = nil
                completion(urls)
            }
            picker.delegate = delegate
            self.activePicker = delegate
            top.present(picker, animated: true)
        }
    }

    @objc func pickFiles(_ call: CAPPluginCall) {
        let multiple = call.getBool("multiple") ?? false
        var types: [UTType] = [
            UTType(filenameExtension: "md"),
            UTType(filenameExtension: "markdown"),
            UTType(filenameExtension: "mdx"),
            UTType("net.daringfireball.markdown")
        ].compactMap { $0 }
        types.append(.plainText)
        presentPicker(call, types: types, multiple: multiple) { urls in
            self.workQueue.async {
                let roots = urls.map { self.addRoot($0, kind: .file) }
                call.resolve(["roots": roots])
            }
        }
    }

    @objc func pickFolder(_ call: CAPPluginCall) {
        presentPicker(call, types: [.folder], multiple: false) { urls in
            self.workQueue.async {
                guard let url = urls.first else {
                    call.resolve([:])
                    return
                }
                call.resolve(["root": self.addRoot(url, kind: .folder)])
            }
        }
    }

    // MARK: - Roots

    @objc func roots(_ call: CAPPluginCall) {
        run(call) {
            var out: [[String: Any]] = []
            for index in self.stored.indices {
                let accessible = (try? self.resolveStored(index)) != nil
                let r = self.stored[index]
                out.append(self.rootJSON(id: r.id, kind: r.kind, name: r.name, writable: r.writable,
                                         persistent: true, accessible: accessible))
            }
            for t in self.transient {
                out.append(self.rootJSON(id: t.id, kind: t.kind, name: t.name, writable: t.writable,
                                         persistent: false, accessible: true))
            }
            return ["roots": out]
        }
    }

    @objc func forget(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        run(call) {
            // iOS has nothing to release: dropping the bookmark ends the grant.
            self.stored.removeAll { $0.id == id }
            self.transient.removeAll { $0.id == id }
            self.resolvedURLs.removeValue(forKey: id)
            self.saveStore()
            return [:]
        }
    }

    /// A file another app handed us. In place → a persistent file root on the
    /// original; otherwise iOS copied it into Documents/Inbox: return its bytes
    /// and delete the copy (the Inbox folder shows up in the Files app).
    @objc func adopt(_ call: CAPPluginCall) {
        let urlString = call.getString("url") ?? ""
        let inPlace = call.getBool("inPlace") ?? false
        run(call) {
            guard let parsed = URL(string: urlString), parsed.isFileURL else {
                throw HFError.inval("Not a file URL: \(urlString)")
            }
            let url = HorseFilesPlugin.takeIncomingURL(urlString) ?? parsed
            let started = url.startAccessingSecurityScopedResource()
            defer { if started { url.stopAccessingSecurityScopedResource() } }
            if inPlace && (started || FileManager.default.isReadableFile(atPath: url.path)) {
                // A file inside a folder the user already added is that
                // folder's file: JS then focuses the tab it may already have
                // open instead of opening the same file a second time.
                if let inside = self.folderContaining(url) { return inside }
                return ["root": self.addRoot(url, kind: .file)]
            }
            let data = try self.coordinatedRead(url) { try Data(contentsOf: $0) }
            self.removeInboxCopy(url)
            return ["copy": ["name": url.lastPathComponent, "data": data.base64EncodedString()]]
        }
    }

    /// `{ root, rel }` for the stored / transient folder root that contains
    /// `url`, or nil. Paths are compared after resolving symlinks
    /// (/private/var vs /var).
    private func folderContaining(_ url: URL) -> [String: Any]? {
        let path = url.standardizedFileURL.resolvingSymlinksInPath().path
        func relative(to folder: URL) -> String? {
            let base = folder.standardizedFileURL.resolvingSymlinksInPath().path
            guard path.hasPrefix(base + "/") else { return nil }
            let rel = String(path.dropFirst(base.count + 1))
            return rel.isEmpty ? nil : rel
        }
        for root in stored where root.kind == .folder {
            guard let folder = try? handle(for: root.id, fresh: false).url, let rel = relative(to: folder) else { continue }
            return ["root": rootJSON(id: root.id, kind: .folder, name: root.name, writable: root.writable, persistent: true, accessible: true),
                    "rel": rel]
        }
        for root in transient where root.kind == .folder {
            guard let rel = relative(to: root.url) else { continue }
            return ["root": rootJSON(id: root.id, kind: .folder, name: root.name, writable: root.writable, persistent: false, accessible: true),
                    "rel": rel]
        }
        return nil
    }

    /// Deletes a copy iOS made for us (Documents/Inbox, or tmp/<bundle>-Inbox),
    /// and its Inbox folder once empty. Never touches files outside the app.
    private func removeInboxCopy(_ url: URL) {
        let fm = FileManager.default
        let path = url.standardizedFileURL.resolvingSymlinksInPath().path
        var bases: [String] = []
        if let docs = fm.urls(for: .documentDirectory, in: .userDomainMask).first {
            bases.append(docs.appendingPathComponent("Inbox").standardizedFileURL.resolvingSymlinksInPath().path)
        }
        bases.append(URL(fileURLWithPath: NSTemporaryDirectory()).standardizedFileURL.resolvingSymlinksInPath().path)
        guard bases.contains(where: { path.hasPrefix($0 + "/") }) else { return }
        try? fm.removeItem(at: url)
        let parent = url.deletingLastPathComponent()
        if parent.lastPathComponent.hasSuffix("Inbox"),
           let left = try? fm.contentsOfDirectory(atPath: parent.path), left.isEmpty {
            try? fm.removeItem(at: parent)
        }
    }

    @objc func pendingIncoming(_ call: CAPPluginCall) {
        call.resolve(["items": HorseFilesPlugin.drainIncoming()])
    }

    // MARK: - File operations

    @objc func stat(_ call: CAPPluginCall) {
        let id = call.getString("id")
        let rel = call.getString("rel")
        run(call) {
            try self.withRoot(id) { root in
                let url = try self.target(root, rel)
                let fm = FileManager.default
                var isDir: ObjCBool = false
                if fm.fileExists(atPath: url.path, isDirectory: &isDir) {
                    let attrs = try fm.attributesOfItem(atPath: url.path)
                    let size = isDir.boolValue ? 0 : ((attrs[.size] as? NSNumber)?.intValue ?? 0)
                    return ["exists": true, "type": isDir.boolValue ? "dir" : "file",
                            "mtime": self.mtimeMs(attrs[.modificationDate] as? Date), "size": size]
                }
                if fm.fileExists(atPath: self.placeholder(for: url).path) {
                    try? fm.startDownloadingUbiquitousItem(at: url)
                    return ["exists": true, "type": "file", "mtime": 0, "size": 0]
                }
                return ["exists": false]
            }
        }
    }

    @objc func read(_ call: CAPPluginCall) {
        let id = call.getString("id")
        let rel = call.getString("rel")
        run(call) {
            try self.withRoot(id) { root in
                let url = try self.target(root, rel)
                if !self.itemPresent(url) { throw HFError.noent("No such file: \(url.lastPathComponent)") }
                return try self.coordinatedRead(url) { readURL -> [String: Any] in
                    var isDir: ObjCBool = false
                    if FileManager.default.fileExists(atPath: readURL.path, isDirectory: &isDir), isDir.boolValue {
                        throw HFError.inval("\(readURL.lastPathComponent) is a folder")
                    }
                    let data = try Data(contentsOf: readURL)
                    // Keep every byte (BOM, CRLF). Refuse non-UTF-8 instead of
                    // decoding lossily: a later save would destroy the file.
                    let text = String(decoding: data, as: UTF8.self)
                    if Data(text.utf8) != data {
                        throw HFError.io("\(readURL.lastPathComponent) is not UTF-8 text")
                    }
                    return ["data": text, "mtime": self.mtime(of: readURL)]
                }
            }
        }
    }

    @objc func write(_ call: CAPPluginCall) {
        let id = call.getString("id")
        let rel = call.getString("rel")
        let text = call.getString("data") ?? ""
        let expected = call.getDouble("expectedMtime")
        run(call) {
            try self.withRoot(id) { root in
                let url = try self.target(root, rel)
                try self.ensureDownloaded(url)
                let data = Data(text.utf8)
                return try self.coordinatedWrite(url, .forReplacing) { writeURL -> [String: Any] in
                    let fm = FileManager.default
                    var isDir: ObjCBool = false
                    let exists = fm.fileExists(atPath: writeURL.path, isDirectory: &isDir)
                    if exists && isDir.boolValue { throw HFError.inval("\(writeURL.lastPathComponent) is a folder") }
                    if let expected = expected {
                        if !exists { return ["conflict": "missing"] }
                        let current = self.mtime(of: writeURL)
                        if Double(current) > expected { return ["conflict": "modified", "mtime": current] }
                    }
                    try self.writeData(data, to: writeURL)
                    return ["mtime": self.mtime(of: writeURL)]
                }
            }
        }
    }

    @objc func list(_ call: CAPPluginCall) {
        let id = call.getString("id")
        let rel = call.getString("rel")
        run(call) {
            try self.withRoot(id) { root in
                try self.requireFolder(root, "list")
                let dir = try self.target(root, rel)
                let fm = FileManager.default
                let keys: [URLResourceKey] = [.isDirectoryKey, .contentModificationDateKey, .fileSizeKey]
                let children = try fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: keys, options: [])
                let realNames = Set(children.map { $0.lastPathComponent })
                var entries: [[String: Any]] = []
                for child in children {
                    let name = child.lastPathComponent
                    if name.hasPrefix(".") {
                        // `.<name>.icloud` = an iCloud item not downloaded yet: list
                        // it under its real name and start the download.
                        guard name.hasSuffix(".icloud"), name.count > ".icloud".count + 1 else { continue }
                        let real = String(name.dropFirst().dropLast(".icloud".count))
                        if real.isEmpty || real.hasPrefix(".") || realNames.contains(real) { continue }
                        try? fm.startDownloadingUbiquitousItem(at: dir.appendingPathComponent(real))
                        entries.append(["name": real, "type": "file", "mtime": 0, "size": 0])
                        continue
                    }
                    let values = try? child.resourceValues(forKeys: Set(keys))
                    let isDir = values?.isDirectory ?? false
                    entries.append(["name": name, "type": isDir ? "dir" : "file",
                                    "mtime": self.mtimeMs(values?.contentModificationDate),
                                    "size": isDir ? 0 : (values?.fileSize ?? 0)])
                }
                return ["entries": entries]
            }
        }
    }

    @objc func create(_ call: CAPPluginCall) {
        let id = call.getString("id")
        let rel = call.getString("rel")
        let text = call.getString("data") ?? ""
        run(call) {
            try self.withRoot(id) { root in
                try self.requireFolder(root, "create")
                let url = try self.target(root, try self.requireRel(rel))
                if self.itemPresent(url) { throw HFError.exist("\(url.lastPathComponent) already exists") }
                return try self.coordinatedWrite(url, []) { writeURL -> [String: Any] in
                    // withoutOverwriting: fails with EEXIST if something appeared meanwhile.
                    try Data(text.utf8).write(to: writeURL, options: .withoutOverwriting)
                    return ["mtime": self.mtime(of: writeURL)]
                }
            }
        }
    }

    @objc func mkdir(_ call: CAPPluginCall) {
        let id = call.getString("id")
        let rel = call.getString("rel")
        run(call) {
            try self.withRoot(id) { root in
                try self.requireFolder(root, "mkdir")
                let url = try self.target(root, try self.requireRel(rel))
                if self.itemPresent(url) { throw HFError.exist("\(url.lastPathComponent) already exists") }
                try self.coordinatedWrite(url, []) { writeURL in
                    try FileManager.default.createDirectory(at: writeURL, withIntermediateDirectories: false)
                }
                return [:]
            }
        }
    }

    @objc func move(_ call: CAPPluginCall) {
        let id = call.getString("id")
        let from = call.getString("from")
        let to = call.getString("to")
        run(call) {
            try self.withRoot(id) { root in
                try self.requireFolder(root, "move")
                let src = try self.target(root, try self.requireRel(from))
                let dst = try self.target(root, try self.requireRel(to))
                if src.path == dst.path { return [:] }
                if !self.itemPresent(src) { throw HFError.noent("No such item: \(src.lastPathComponent)") }
                try self.ensureDownloaded(src)
                let fm = FileManager.default
                // A case-only rename (a.md → A.md) on a case-insensitive volume:
                // `to` "exists" but is the same item. FileManager refuses that
                // move, so go through a temporary name.
                var sameItem = false
                if self.itemPresent(dst) {
                    let a = try? src.resourceValues(forKeys: [.fileResourceIdentifierKey]).fileResourceIdentifier
                    let b = try? dst.resourceValues(forKeys: [.fileResourceIdentifierKey]).fileResourceIdentifier
                    if let a = a, let b = b, a.isEqual(b) {
                        sameItem = true
                    } else {
                        throw HFError.exist("\(dst.lastPathComponent) already exists")
                    }
                }
                let coordinator = NSFileCoordinator(filePresenter: nil)
                var coordinationError: NSError?
                var moveError: Error?
                coordinator.coordinate(writingItemAt: src, options: .forMoving,
                                       writingItemAt: dst, options: .forReplacing,
                                       error: &coordinationError) { s, d in
                    do {
                        coordinator.item(at: s, willMoveTo: d)
                        if sameItem {
                            let tmp = s.deletingLastPathComponent()
                                .appendingPathComponent(".hm-move-\(UUID().uuidString)")
                            try fm.moveItem(at: s, to: tmp)
                            do {
                                try fm.moveItem(at: tmp, to: d)
                            } catch {
                                try? fm.moveItem(at: tmp, to: s)
                                throw error
                            }
                        } else {
                            try fm.moveItem(at: s, to: d)
                        }
                        coordinator.item(at: s, didMoveTo: d)
                    } catch {
                        moveError = error
                    }
                }
                if let error = coordinationError { throw error }
                if let error = moveError { throw error }
                return [:]
            }
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        let id = call.getString("id")
        let rel = call.getString("rel")
        run(call) {
            try self.withRoot(id) { root in
                if root.kind == .folder && (rel ?? "").isEmpty {
                    throw HFError.inval("Refusing to delete the root folder itself")
                }
                let url = try self.target(root, rel)
                let fm = FileManager.default
                // An evicted iCloud item exists only as its placeholder; deleting
                // the placeholder deletes the item.
                let victim = self.isEvicted(url) ? self.placeholder(for: url) : url
                if !fm.fileExists(atPath: victim.path) { throw HFError.noent("No such item: \(url.lastPathComponent)") }
                try self.coordinatedWrite(victim, .forDeleting) { deleteURL in
                    try fm.removeItem(at: deleteURL)
                }
                return [:]
            }
        }
    }
}
