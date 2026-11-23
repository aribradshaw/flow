import SwiftUI
import WebKit

// The web app's canvases (mind map, timeline, AgentFlow and the 3D office) in a WKWebView that shares the
// sign-in's website data store. A native switcher on top changes the page's hash (public/split-core.js),
// and the web app's own top bar is hidden here, so the app never shows two sets of tabs.
struct CanvasScreen: View {
    enum Canvas: String, CaseIterable, Identifiable {
        case chart, timeline, agentflow, office
        var id: String { rawValue }
        var title: String {
            switch self {
            case .chart: "Map"
            case .timeline: "Timeline"
            case .agentflow: "Agents"
            case .office: "Office"
            }
        }
        var hash: String { self == .chart ? "#chart" : "#\(rawValue)" }
    }

    @Environment(AppModel.self) private var model
    @State private var canvas: Canvas = .chart
    @State private var web = CanvasWeb()

    var body: some View {
        NavigationStack {
            CanvasWebView(web: web)
                .overlay {
                    if !web.loadedOnce {
                        ProgressView().controlSize(.large)
                    }
                }
                .overlay(alignment: .top) {
                    if let message = web.failure {
                        Label(message, systemImage: "wifi.exclamationmark")
                            .font(.footnote)
                            .padding(10)
                            .background(.regularMaterial, in: .capsule)
                            .padding(.top, 8)
                            .onTapGesture { web.reload() }
                    }
                }
                .toolbar {
                    ToolbarItem(placement: .principal) {
                        Picker("View", selection: $canvas) {
                            ForEach(Canvas.allCases) { Text($0.title).tag($0) }
                        }
                        .pickerStyle(.segmented)
                        .frame(maxWidth: 360)
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Reload", systemImage: "arrow.clockwise") { web.reload() }
                    }
                }
                .navigationBarTitleDisplayMode(.inline)
                .toolbarBackground(.visible, for: .navigationBar)
                .onAppear { web.show(server: model.server, hash: canvas.hash) }
                .onChange(of: canvas) { web.show(server: model.server, hash: canvas.hash) }
                .sensoryFeedback(.selection, trigger: canvas)
        }
    }
}

@MainActor
@Observable
final class CanvasWeb: NSObject, WKNavigationDelegate, WKUIDelegate {
    let webView: WKWebView
    private(set) var loading = false
    private(set) var loadedOnce = false
    private(set) var failure: String?
    private var server: URL?

    // Hides the web app's top bar (its tabs, environment and account live natively in the app) and
    // tightens a few things for touch. The page's own logic is untouched.
    private static let appStyle = """
    #top{display:none!important}
    html,body{-webkit-tap-highlight-color:transparent;overscroll-behavior:none}
    """

    override init() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        let css = CanvasWeb.appStyle.replacingOccurrences(of: "\n", with: " ")
        let js = "(function(){var s=document.createElement('style');s.id='flow-ios';s.textContent=\(String(reflecting: css));(document.head||document.documentElement).appendChild(s);document.documentElement.classList.add('flow-ios');})();"
        config.userContentController.addUserScript(WKUserScript(source: js, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #if DEBUG
        webView.isInspectable = true
        #endif
    }

    func show(server: URL, hash: String) {
        if self.server == server, webView.url != nil {
            webView.evaluateJavaScript("location.hash = \(String(reflecting: hash))")
            return
        }
        self.server = server
        guard let url = URL(string: "/\(hash)", relativeTo: server)?.absoluteURL else { return }
        webView.load(URLRequest(url: url))
    }

    func reload() { failure = nil; webView.reload() }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { loading = true }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loading = false; loadedOnce = true; failure = nil }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { loading = false }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        loading = false
        loadedOnce = true
        failure = "Couldn't load Flow. Tap to retry."
    }

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
