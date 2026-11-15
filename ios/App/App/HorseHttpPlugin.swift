import Foundation
import Capacitor

/// HorseHttp: the phone's HTTP client for cloud sync (WebDAV / S3). The WebView's
/// fetch cannot be used: CORS, PROPFIND / MKCOL, a User-Agent of our choosing
/// (数据胶囊 requires "rclone").
///
/// request({ method, url, headers, bodyBase64, timeoutMs })
///   → { status, headers: { lower-case name: value }, bodyBase64 }
/// Rejects with code BAD_URL (not http/https), TIMEOUT (the whole exchange
/// took longer than timeoutMs), TOO_LARGE (response over 200 MB) or NETWORK;
/// a message names the host only, never the query or credentials.
///
/// One shared ephemeral URLSession (no disk cache, no cookies, connections
/// reused). Redirects are followed except https → http; Authorization is
/// dropped on a redirect to another host. URLSession decodes gzip / deflate /
/// br bodies itself; their Content-Encoding / Content-Length headers are then
/// removed, so headers describe the bytes returned (as OkHttp does on Android).
@objc(HorseHttpPlugin)
public class HorseHttpPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HorseHttpPlugin"
    public let jsName = "HorseHttp"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise)
    ]

    static let maxResponseBytes: Int64 = 200 * 1024 * 1024
    private static let defaultTimeoutMs: Double = 60_000

    private lazy var engine = HorseHttpEngine()

    @objc func request(_ call: CAPPluginCall) {
        let method = (call.getString("method") ?? "GET").trimmingCharacters(in: .whitespaces)
        let urlString = call.getString("url") ?? ""
        guard let url = URL(string: urlString),
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = url.host, !host.isEmpty else {
            call.reject("Only http and https URLs are allowed", "BAD_URL")
            return
        }
        let tokenChars = CharacterSet(charactersIn: "!#$%&'*+.^_`|~-")
            .union(CharacterSet(charactersIn: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"))
        guard !method.isEmpty, method.unicodeScalars.allSatisfy({ tokenChars.contains($0) }) else {
            call.reject("Bad HTTP method", "BAD_URL")
            return
        }
        var timeoutMs = call.getDouble("timeoutMs") ?? Self.defaultTimeoutMs
        if !(timeoutMs > 0) { timeoutMs = Self.defaultTimeoutMs }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.httpShouldHandleCookies = false
        // Idle timeout; the whole-exchange deadline is enforced by the engine.
        request.timeoutInterval = timeoutMs / 1000
        let headers = call.getObject("headers") ?? [:]
        for (name, value) in headers {
            let lower = name.lowercased()
            // URLSession owns these; setting them is ignored or breaks framing.
            if lower == "content-length" || lower == "connection" || lower == "host" { continue }
            let text: String
            if let s = value as? String { text = s } else if let n = value as? NSNumber { text = n.stringValue } else { continue }
            request.setValue(text, forHTTPHeaderField: name)
        }
        let upper = method.uppercased()
        if upper != "GET" && upper != "HEAD" {
            if let b64 = call.getString("bodyBase64") {
                guard let data = Data(base64Encoded: b64, options: .ignoreUnknownCharacters) else {
                    call.reject("Request body is not valid base64", "BAD_URL")
                    return
                }
                request.httpBody = data
            } else if ["POST", "PUT", "PATCH", "PROPPATCH", "REPORT"].contains(upper) {
                request.httpBody = Data()
            }
        }

        engine.run(request, host: host, isHead: upper == "HEAD", timeout: timeoutMs / 1000) { result in
            switch result {
            case .success(let (status, outHeaders, body)):
                call.resolve([
                    "status": status,
                    "headers": outHeaders,
                    "bodyBase64": body.base64EncodedString()
                ])
            case .failure(let error):
                call.reject(error.message, error.code)
            }
        }
    }
}

struct HorseHttpError: Error {
    let code: String
    let message: String
}

/// Shared session + per-task state, driven by the session delegate.
final class HorseHttpEngine: NSObject, URLSessionDataDelegate {
    typealias Completion = (Result<(Int, [String: String], Data), HorseHttpError>) -> Void

    private final class TaskState {
        let host: String
        let isHead: Bool
        let completion: Completion
        var data = Data()
        var response: HTTPURLResponse?
        var failure: HorseHttpError?
        var timer: DispatchWorkItem?
        var done = false

        init(host: String, isHead: Bool, completion: @escaping Completion) {
            self.host = host
            self.isHead = isHead
            self.completion = completion
        }
    }

    private let lock = NSLock()
    private var states: [Int: TaskState] = [:]
    private let delegateQueue: OperationQueue = {
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1
        q.name = "com.horsemd.horsehttp"
        return q
    }()
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        config.urlCredentialStorage = nil
        config.timeoutIntervalForResource = 24 * 60 * 60
        config.waitsForConnectivity = false
        return URLSession(configuration: config, delegate: self, delegateQueue: delegateQueue)
    }()

    func run(_ request: URLRequest, host: String, isHead: Bool, timeout: TimeInterval, completion: @escaping Completion) {
        let task = session.dataTask(with: request)
        let state = TaskState(host: host, isHead: isHead, completion: completion)
        let id = task.taskIdentifier
        let timer = DispatchWorkItem { [weak self, weak task] in
            guard let self = self else { return }
            self.lock.lock()
            let s = self.states[id]
            if let s = s, s.failure == nil { s.failure = HorseHttpError(code: "TIMEOUT", message: "Request to \(host) timed out") }
            self.lock.unlock()
            task?.cancel()
        }
        state.timer = timer
        lock.lock()
        states[id] = state
        lock.unlock()
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout, execute: timer)
        task.resume()
    }

    private func state(for task: URLSessionTask) -> TaskState? {
        lock.lock()
        defer { lock.unlock() }
        return states[task.taskIdentifier]
    }

    private func fail(_ task: URLSessionTask, _ state: TaskState, _ error: HorseHttpError) {
        lock.lock()
        if state.failure == nil { state.failure = error }
        lock.unlock()
        task.cancel()
    }

    // MARK: URLSessionTaskDelegate / URLSessionDataDelegate

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        let fromScheme = task.originalRequest?.url?.scheme?.lowercased()
        let toScheme = request.url?.scheme?.lowercased()
        if (toScheme != "http" && toScheme != "https") || (fromScheme == "https" && toScheme == "http") {
            completionHandler(nil) // deliver the 3xx itself
            return
        }
        var next = request
        let fromHost = task.currentRequest?.url?.host?.lowercased()
        if let toHost = request.url?.host?.lowercased(), toHost != fromHost {
            next.setValue(nil, forHTTPHeaderField: "Authorization")
        }
        completionHandler(next)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let state = state(for: dataTask) else { completionHandler(.cancel); return }
        if let http = response as? HTTPURLResponse {
            state.response = http
        }
        let encoding = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Encoding")?.lowercased() ?? ""
        let encoded = !encoding.isEmpty && encoding != "identity"
        if !state.isHead && !encoded && response.expectedContentLength > HorseHttpPlugin.maxResponseBytes {
            fail(dataTask, state, HorseHttpError(code: "TOO_LARGE", message: "Response from \(state.host) is larger than 200 MB"))
            completionHandler(.cancel)
            return
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let state = state(for: dataTask) else { return }
        if Int64(state.data.count) + Int64(data.count) > HorseHttpPlugin.maxResponseBytes {
            state.data = Data()
            fail(dataTask, state, HorseHttpError(code: "TOO_LARGE", message: "Response from \(state.host) is larger than 200 MB"))
            return
        }
        state.data.append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let state = states.removeValue(forKey: task.taskIdentifier)
        lock.unlock()
        guard let state = state, !state.done else { return }
        state.done = true
        state.timer?.cancel()
        if let failure = state.failure {
            state.completion(.failure(failure))
            return
        }
        if let error = error {
            state.completion(.failure(Self.classify(error, host: state.host)))
            return
        }
        guard let http = state.response else {
            state.completion(.failure(HorseHttpError(code: "NETWORK", message: "Request to \(state.host) got no HTTP response")))
            return
        }
        state.completion(.success((http.statusCode, Self.headers(of: http, isHead: state.isHead), state.data)))
    }

    // MARK: helpers

    private static func classify(_ error: Error, host: String) -> HorseHttpError {
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorTimedOut {
            return HorseHttpError(code: "TIMEOUT", message: "Request to \(host) timed out")
        }
        // NSError descriptions can quote the URL; report the domain/code only.
        return HorseHttpError(code: "NETWORK", message: "Request to \(host) failed (\(ns.domain) \(ns.code))")
    }

    private static func headers(of http: HTTPURLResponse, isHead: Bool) -> [String: String] {
        var out: [String: String] = [:]
        for (key, value) in http.allHeaderFields {
            guard let name = (key as? String)?.lowercased() else { continue }
            let text = (value as? String) ?? "\(value)"
            out[name] = repairUtf8(text)
        }
        // URLSession already decoded the body: drop the headers about the encoded form.
        if !isHead, let enc = out["content-encoding"]?.lowercased(), ["gzip", "x-gzip", "deflate", "br"].contains(enc) {
            out.removeValue(forKey: "content-encoding")
            out.removeValue(forKey: "content-length")
        }
        return out
    }

    /// A header value whose raw bytes were UTF-8 but were read as Latin-1
    /// (every scalar ≤ U+00FF, at least one ≥ U+0080, and the bytes are valid
    /// UTF-8) is returned as the UTF-8 text, like the desktop client does.
    private static func repairUtf8(_ text: String) -> String {
        var bytes: [UInt8] = []
        var high = false
        for scalar in text.unicodeScalars {
            if scalar.value > 0xFF { return text }
            if scalar.value >= 0x80 { high = true }
            bytes.append(UInt8(scalar.value))
        }
        guard high, let decoded = String(bytes: bytes, encoding: .utf8) else { return text }
        return decoded
    }
}
