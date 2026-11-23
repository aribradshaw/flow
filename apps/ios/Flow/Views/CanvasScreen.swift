import SwiftUI
import WebKit

// The web app (mind map, timeline, AgentFlow and its 3D office, with its own tabs) in a WKWebView that
// shares the sign-in's website data store, so it opens signed in.
struct CanvasScreen: View {
    @Environment(AppModel.self) private var model
    @State private var web = CanvasWeb()

    var body: some View {
        CanvasWebView(web: web)
            .ignoresSafeArea(edges: .bottom)
            .overlay {
                if web.loading && !web.loadedOnce { ProgressView() }
            }
            .onAppear { web.show(server: model.server) }
    }
}

@MainActor
@Observable
final class CanvasWeb: NSObject, WKNavigationDelegate, WKUIDelegate {
    let webView: WKWebView
    private(set) var loading = false
    private(set) var loadedOnce = false
    private var server: URL?

    override init() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        #if DEBUG
        webView.isInspectable = true
        #endif
    }

    func show(server: URL) {
        if self.server == server, webView.url != nil { return }
        self.server = server
        webView.load(URLRequest(url: server))
    }

    func reload() { webView.reload() }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { loading = true }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loading = false; loadedOnce = true }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { loading = false }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { loading = false }

    // Links to other sites open in Safari; Flow's own pages (and OneProfileID sign-in) stay here.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url, action.targetFrame?.isMainFrame != false else { return .allow }
        if url.host == server?.host || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" { return .allow }
        if action.navigationType == .linkActivated {
            await UIApplication.shared.open(url)
            return .cancel
        }
        return .allow
    }

    // window.open / target=_blank: open outside the app.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { UIApplication.shared.open(url) }
        return nil
    }
}

private struct CanvasWebView: UIViewRepresentable {
    let web: CanvasWeb
    func makeUIView(context: Context) -> WKWebView { web.webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
