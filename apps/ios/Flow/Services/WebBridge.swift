import Foundation
import WebKit

// A hidden WKWebView parked on the Flow server's own origin. Sign-in requests go through its fetch(),
// so they carry the right Origin header (server.mjs trusted()) and the session cookies Flow sets land
// in the app's persistent website data store. The visible web views (mind map, timeline, office)
// share that store, so they are signed in too.
@MainActor
final class WebBridge: NSObject, WKNavigationDelegate {
    static let shared = WebBridge()

    private let webView: WKWebView
    private var origin: URL?
    private var loading: CheckedContinuation<Void, Error>?

    override init() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        webView.navigationDelegate = self
    }

    struct Response {
        let status: Int
        let body: Data

        func decode<T: Decodable>(_ type: T.Type) throws -> T {
            try JSONDecoder().decode(T.self, from: body)
        }

        // The server's {error} message, or a fallback.
        var errorMessage: String {
            let o = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
            return (o?["error"] as? String) ?? "Flow answered \(status)."
        }
    }

    // fetch(path) from the server's origin, with its cookies. body is sent as JSON.
    func fetch(_ server: URL, _ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> Response {
        try await park(on: server)
        let json = try body.map { String(decoding: try JSONSerialization.data(withJSONObject: $0), as: UTF8.self) }
        let script = """
        const r = await fetch(path, {method, credentials: 'same-origin', cache: 'no-store',
          headers: json === null ? {accept: 'application/json'} : {accept: 'application/json', 'content-type': 'application/json'},
          body: json === null ? undefined : json});
        return JSON.stringify({status: r.status, body: await r.text()});
        """
        let out = try await webView.callAsyncJavaScript(script, arguments: ["path": path, "method": method, "json": json ?? NSNull()], contentWorld: .defaultClient)
        struct Raw: Decodable { let status: Int; let body: String }
        guard let text = out as? String, let raw = try? JSONDecoder().decode(Raw.self, from: Data(text.utf8)) else {
            throw FlowError(status: 0, code: nil, message: "Could not reach Flow.")
        }
        return Response(status: raw.status, body: Data(raw.body.utf8))
    }

    // Forget every cookie and cache of every site (sign out).
    func clearWebsiteData() async {
        let store = WKWebsiteDataStore.default()
        await store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
        origin = nil
    }

    // Load a small same-origin page once per server: the session JSON is enough to own the origin.
    private func park(on server: URL) async throws {
        if origin == server { return }
        guard let url = URL(string: "/api/auth/session", relativeTo: server)?.absoluteURL else {
            throw FlowError(status: 0, code: nil, message: "The server address is not valid.")
        }
        loading?.resume(throwing: CancellationError())
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            loading = c
            webView.load(URLRequest(url: url, timeoutInterval: 20))
        }
        origin = server
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loading?.resume()
        loading = nil
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        loading?.resume(throwing: FlowError(status: 0, code: nil, message: "Could not reach Flow: \(error.localizedDescription)"))
        loading = nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        loading?.resume(throwing: FlowError(status: 0, code: nil, message: "Could not reach Flow: \(error.localizedDescription)"))
        loading = nil
    }
}
