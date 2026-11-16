import Foundation
import UIKit
import WebKit
import Capacitor

/// HorsePdf: renders an export HTML document to PDF bytes on the phone (the
/// desktop uses Electron's printToPDF; this is its iOS counterpart).
///
/// render({ html, pageWidthPt, pageHeightPt, margins: { top, right, bottom, left } (pt),
///          resourceScript, timeoutMs })
///   → { data: <base64 PDF>, pageCount, resources: <object the resourceScript
///       resolved to, or null> }
/// Rejects with code BUSY (a render is already running: one at a time),
/// TIMEOUT (the whole render took longer than timeoutMs, default 90 s) or
/// RENDER (bad arguments, load / print failure, PDF over 200 MB).
///
/// How: a WKWebView with a non-persistent data store (no cookies, no cache,
/// nothing kept) is added to the key window far off-screen (origin x −20000,
/// so WebKit treats it as in a window and lays it out and loads images; the
/// user never sees it). It is never shown and is torn down after every render,
/// also on timeout / error. `loadHTMLString(html, baseURL: nil)`: the page has
/// no file access; it may load what its own HTML references (https images).
/// Every navigation after the initial load is cancelled. JavaScript stays
/// enabled only so the app can evaluate `resourceScript` (callAsyncJavaScript,
/// iOS 14+; the deployment target is 15): the export page itself carries a CSP
/// without script-src, so none of its own scripts run. A failing script gives
/// resources = null, not an error.
///
/// Layout width: the view's width is the printable width in CSS px,
/// (pageWidthPt − left − right) × 96 / 72, so the resource script's display
/// math measurement matches the page.
///
/// Printing: UIPrintPageRenderer + the web view's viewPrintFormatter, with
/// paperRect = the page and printableRect = the page inset by the margins
/// (set through KVC, the documented-by-practice way). iOS uses printableRect
/// for the margins; Android leaves them to the page's CSS `@page` margin.
/// Each page is drawn into a PDF context with drawPage(at:in:). Everything
/// runs on the main thread except the base64 encoding.
@objc(HorsePdfPlugin)
public class HorsePdfPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HorsePdfPlugin"
    public let jsName = "HorsePdf"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "render", returnType: CAPPluginReturnPromise)
    ]

    static let maxPdfBytes = 200 * 1024 * 1024
    private static let defaultTimeoutMs: Double = 90_000
    /// 200 inches: larger pages are not a real document.
    private static let maxPagePt: Double = 14_400

    /// The running render; main thread only.
    private var job: HorsePdfJob?

    @objc func render(_ call: CAPPluginCall) {
        let html = call.getString("html") ?? ""
        let width = call.getDouble("pageWidthPt") ?? 0
        let height = call.getDouble("pageHeightPt") ?? 0
        let margins = call.getObject("margins") ?? [:]
        func margin(_ key: String) -> Double {
            if let n = margins[key] as? NSNumber { return max(0, n.doubleValue) }
            return 0
        }
        let top = margin("top"), right = margin("right"), bottom = margin("bottom"), left = margin("left")
        let script = call.getString("resourceScript")
        var timeoutMs = call.getDouble("timeoutMs") ?? Self.defaultTimeoutMs
        // Optional width of the off-screen view in CSS px (the renderer passes
        // the printable width × 96 / 72 × its page zoom); else that without zoom.
        let viewportWidth = call.getDouble("viewportWidth") ?? 0
        if !(timeoutMs > 0) { timeoutMs = Self.defaultTimeoutMs }

        guard !html.isEmpty else {
            call.reject("No HTML to render", "RENDER")
            return
        }
        guard width.isFinite, height.isFinite, width > 0, height > 0,
              width <= Self.maxPagePt, height <= Self.maxPagePt,
              left + right < width - 1, top + bottom < height - 1 else {
            call.reject("Bad page size or margins", "RENDER")
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if self.job != nil {
                call.reject("Another PDF is being rendered", "BUSY")
                return
            }
            guard let window = self.hostWindow() else {
                call.reject("No window to render the PDF in", "RENDER")
                return
            }
            let job = HorsePdfJob(
                html: html,
                pageSize: CGSize(width: width, height: height),
                margins: UIEdgeInsets(top: top, left: left, bottom: bottom, right: right),
                resourceScript: script,
                timeout: timeoutMs / 1000,
                viewportWidth: viewportWidth.isFinite && viewportWidth > 0 ? CGFloat(viewportWidth) : nil
            )
            self.job = job
            job.start(in: window) { [weak self] result in
                // Main thread: the job has already torn its web view down.
                self?.job = nil
                switch result {
                case .success(let (data, pageCount, resources)):
                    DispatchQueue.global(qos: .userInitiated).async {
                        let base64 = data.base64EncodedString()
                        call.resolve([
                            "data": base64,
                            "pageCount": pageCount,
                            "resources": resources
                        ])
                    }
                case .failure(let error):
                    call.reject(error.message, error.code)
                }
            }
        }
    }

    private func hostWindow() -> UIWindow? {
        if let window = bridge?.webView?.window { return window }
        if let window = bridge?.viewController?.view.window { return window }
        for scene in UIApplication.shared.connectedScenes {
            guard let windowScene = scene as? UIWindowScene else { continue }
            if let key = windowScene.windows.first(where: { $0.isKeyWindow }) { return key }
            if let any = windowScene.windows.first { return any }
        }
        return nil
    }
}

struct HorsePdfError: Error {
    let code: String
    let message: String
}

/// One render: owns the off-screen web view from creation to teardown.
final class HorsePdfJob: NSObject, WKNavigationDelegate {
    typealias Completion = (Result<(Data, Int, Any), HorsePdfError>) -> Void

    private let html: String
    private let pageSize: CGSize
    private let margins: UIEdgeInsets
    private let resourceScript: String?
    private let timeout: TimeInterval
    private let viewportWidth: CGFloat?

    private var webView: WKWebView?
    private var completion: Completion?
    private var timer: DispatchWorkItem?
    private var initialLoadStarted = false
    private var loaded = false
    private var done = false

    init(html: String, pageSize: CGSize, margins: UIEdgeInsets, resourceScript: String?, timeout: TimeInterval, viewportWidth: CGFloat? = nil) {
        self.html = html
        self.pageSize = pageSize
        self.margins = margins
        self.resourceScript = resourceScript
        self.timeout = timeout
        self.viewportWidth = viewportWidth
    }

    func start(in window: UIWindow, completion: @escaping Completion) {
        self.completion = completion

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.suppressesIncrementalRendering = false
        config.allowsInlineMediaPlayback = false
        config.mediaTypesRequiringUserActionForPlayback = .all
        config.dataDetectorTypes = []
        config.preferences.javaScriptCanOpenWindowsAutomatically = false

        let printableWidthPt = pageSize.width - margins.left - margins.right
        // The resource script measures (math wrapping) at this width, so it
        // should be the page's layout width: the renderer zooms the page
        // (mobile-export.js IOS_PRINT_ZOOM) and passes the matching width.
        let cssWidth = (viewportWidth ?? printableWidthPt * 96 / 72).rounded(.down)
        let view = WKWebView(frame: CGRect(x: -20_000, y: 0, width: cssWidth, height: 1_000), configuration: config)
        view.navigationDelegate = self
        view.isUserInteractionEnabled = false
        view.isAccessibilityElement = false
        view.accessibilityElementsHidden = true
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.scrollView.isScrollEnabled = false
        webView = view
        // Behind everything else in the window as well as off-screen.
        window.insertSubview(view, at: 0)

        let timer = DispatchWorkItem { [weak self] in
            self?.finish(.failure(HorsePdfError(code: "TIMEOUT", message: "PDF rendering timed out")))
        }
        self.timer = timer
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout, execute: timer)

        initialLoadStarted = true
        view.loadHTMLString(html, baseURL: nil)
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? false
        let scheme = navigationAction.request.url?.scheme?.lowercased() ?? "about"
        if isMainFrame {
            // Only the loadHTMLString load itself (about:blank); links, meta refresh,
            // form posts and window.location changes are refused.
            decisionHandler(!loaded && initialLoadStarted && scheme == "about" ? .allow : .cancel)
            return
        }
        // Subframes (an https iframe in the document) may load web content only.
        decisionHandler(["https", "http", "about", "data", "blob"].contains(scheme) ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !done, !loaded else { return }
        loaded = true
        runResourceScript()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard !loaded else { return }
        let ns = error as NSError
        finish(.failure(HorsePdfError(code: "RENDER", message: "Could not load the PDF page (\(ns.domain) \(ns.code))")))
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard !loaded else { return }
        let ns = error as NSError
        finish(.failure(HorsePdfError(code: "RENDER", message: "Could not load the PDF page (\(ns.domain) \(ns.code))")))
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        finish(.failure(HorsePdfError(code: "RENDER", message: "The PDF page's web content process ended")))
    }

    // MARK: steps

    private func runResourceScript() {
        guard let view = webView, !done else { return }
        guard let script = resourceScript?.trimmingCharacters(in: .whitespacesAndNewlines), !script.isEmpty else {
            printPdf(resources: NSNull())
            return
        }
        // JSON round trip: the result reaches native as plain JSON types only.
        let body = "const __hmResult = await (\n" + script + "\n);\nreturn JSON.stringify(__hmResult === undefined ? null : __hmResult);"
        view.callAsyncJavaScript(body, arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self = self, !self.done else { return }
            var resources: Any = NSNull()
            if case .success(let value) = result,
               let text = value as? String,
               let data = text.data(using: .utf8),
               let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]),
               let dict = object as? [String: Any],
               let js = JSTypes.coerceDictionaryToJSObject(dict) {
                resources = js
            }
            self.printPdf(resources: resources)
        }
    }

    private func printPdf(resources: Any) {
        guard let view = webView, !done else { return }
        let renderer = UIPrintPageRenderer()
        renderer.addPrintFormatter(view.viewPrintFormatter(), startingAtPageAt: 0)
        let paper = CGRect(origin: .zero, size: pageSize)
        let printable = paper.inset(by: margins)
        renderer.setValue(NSValue(cgRect: paper), forKey: "paperRect")
        renderer.setValue(NSValue(cgRect: printable), forKey: "printableRect")

        let pageCount = renderer.numberOfPages
        guard pageCount > 0 else {
            finish(.failure(HorsePdfError(code: "RENDER", message: "The PDF has no pages")))
            return
        }

        let data = NSMutableData()
        UIGraphicsBeginPDFContextToData(data, paper, [
            kCGPDFContextCreator as String: "HorseMD"
        ])
        renderer.prepare(forDrawingPages: NSRange(location: 0, length: pageCount))
        let bounds = UIGraphicsGetPDFContextBounds()
        var tooLarge = false
        for index in 0..<pageCount {
            UIGraphicsBeginPDFPage()
            renderer.drawPage(at: index, in: bounds)
            if data.length > HorsePdfPlugin.maxPdfBytes {
                tooLarge = true
                break
            }
        }
        UIGraphicsEndPDFContext()

        if tooLarge || data.length > HorsePdfPlugin.maxPdfBytes {
            finish(.failure(HorsePdfError(code: "RENDER", message: "The PDF is larger than 200 MB")))
            return
        }
        guard data.length > 0 else {
            finish(.failure(HorsePdfError(code: "RENDER", message: "The PDF is empty")))
            return
        }
        finish(.success((data as Data, pageCount, resources)))
    }

    /// Ends the job once: cancels the timer, destroys the web view, then reports.
    private func finish(_ result: Result<(Data, Int, Any), HorsePdfError>) {
        guard !done else { return }
        done = true
        timer?.cancel()
        timer = nil
        if let view = webView {
            view.stopLoading()
            view.navigationDelegate = nil
            view.removeFromSuperview()
        }
        webView = nil
        let completion = self.completion
        self.completion = nil
        completion?(result)
    }
}
