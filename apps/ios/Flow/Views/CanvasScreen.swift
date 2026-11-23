import SwiftUI
import WebKit

// The Map tab: the mind map and the timeline, native (MindMapView, TimelineView). The 3D office is the
// web app in a WKWebView that shares the sign-in's website data store, with the web's top bar hidden.
struct CanvasScreen: View {
    enum Mode: Hashable { case map, timeline }

    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var mode: Mode = {
        #if DEBUG
        if UserDefaults.standard.string(forKey: "mapMode") == "timeline" { return .timeline }
        #endif
        return .map
    }()
    @State private var map = MapStore()
    @State private var camera = MapCamera()
    @State private var timeline = TimelineStore()
    @State private var timelineMode: TimelineMode?
    @State private var selectedNode: String?
    @State private var selectedItem: TimelineItem?
    @State private var showOffice = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Group {
                switch mode {
                case .map: mapView
                case .timeline: timelineView
                }
            }
            .background(Theme.bg)
            .navigationTitle(mode == .map ? (map.chart?.name ?? "Mind map") : "Timeline")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .safeAreaInset(edge: .top, spacing: 0) {
                HStack {
                    FlowSegmented(options: [Mode.map, .timeline], selection: $mode, title: { $0 == .map ? "Mind map" : "Timeline" })
                    Spacer()
                    if mode == .timeline {
                        FlowSegmented(options: TimelineMode.allCases, selection: Binding(get: { currentTimelineMode }, set: { timelineMode = $0 }), title: \.title)
                    }
                }
                .padding(.horizontal)
                .padding(.vertical, 8)
                .background(Theme.bg)
                .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
            }
            .task(id: model.envID) { await load() }
            .onChange(of: map.chartID) { Task { await loadMap() } }
            .refreshable { await load() }
            .sheet(isPresented: Binding(get: { selectedNode != nil }, set: { if !$0 { selectedNode = nil } })) {
                if let n = map.nodes.first(where: { $0.id == selectedNode }) {
                    NodeSheet(node: n, nodes: map.nodes, edges: map.edges) { id in selectedNode = id }
                }
            }
            .sheet(item: $selectedItem) { ItemSheet(item: $0, store: timeline) }
            .fullScreenCover(isPresented: $showOffice) { OfficeScreen() }
        }
    }

    private var currentTimelineMode: TimelineMode { timelineMode ?? (sizeClass == .regular ? .roadmap : .list) }

    @ViewBuilder
    private var mapView: some View {
        if map.nodes.isEmpty {
            if map.loading || map.loadedKey == nil { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) }
            else {
                ContentUnavailableView("This mind map is empty", systemImage: "point.3.connected.trianglepath.dotted",
                                       description: Text(error ?? "Add entities and people to it in Flow on the web."))
            }
        } else {
            MindMapView(nodes: map.nodes, edges: map.edges, selected: $selectedNode, camera: camera)
                .overlay(alignment: .bottomTrailing) {
                    Button { camera.fitRequest += 1 } label: {
                        Image(systemName: "arrow.up.left.and.arrow.down.right").font(.subheadline.weight(.semibold))
                            .foregroundStyle(Theme.muted)
                            .frame(width: 38, height: 38)
                            .background(Theme.surface, in: .rect(cornerRadius: Theme.corner))
                            .overlay(RoundedRectangle(cornerRadius: Theme.corner).strokeBorder(Theme.line2))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Fit the whole map")
                    .padding()
                }
        }
    }

    @ViewBuilder
    private var timelineView: some View {
        if timeline.items.isEmpty {
            if timeline.loading || timeline.loadedEnv == nil { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) }
            else { ContentUnavailableView("No timeline items yet", systemImage: "calendar", description: Text("Releases, milestones and phases you add in Flow show up here.")) }
        } else if currentTimelineMode == .roadmap {
            TimelineRoadmap(store: timeline) { selectedItem = $0 }
        } else {
            TimelineList(store: timeline) { selectedItem = $0 }
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) { ProfileButton() }
        ToolbarItemGroup(placement: .topBarTrailing) {
            if mode == .map && map.charts.count > 1 {
                Menu {
                    Picker("Mind map", selection: Binding(get: { map.chartID }, set: { map.chartID = $0 })) {
                        ForEach(map.charts) { c in Text(c.name).tag(Optional(c.id)) }
                    }
                } label: {
                    Image(systemName: "rectangle.stack")
                }
                .accessibilityLabel("Choose a mind map")
            }
            Button { showOffice = true } label: { Image(systemName: "building.2") }
                .accessibilityLabel("Open the 3D office")
        }
    }

    private func load() async {
        guard let api = model.api else { return }
        if model.envs.isEmpty { try? await model.loadEnvs() }
        guard let env = model.envID else { return }
        if map.loadedKey?.hasPrefix(env + "/") != true { map.reset() }
        await loadMap()
        do { try await timeline.load(api, env: env) } catch { model.handle(error) }
    }

    private func loadMap() async {
        guard let api = model.api, let env = model.envID else { return }
        do {
            try await map.load(api, env: env)
            camera.fitRequest += 1
            error = nil
        } catch {
            model.handle(error)
            self.error = error.localizedDescription
        }
    }
}

// The 3D office: the web app, full screen (it is 3D and has its own controls).
struct OfficeScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var web = CanvasWeb()

    var body: some View {
        NavigationStack {
            CanvasWebView(web: web)
                .ignoresSafeArea(edges: .bottom)
                .overlay { if !web.loadedOnce { ProgressView().controlSize(.large) } }
                .navigationTitle("Office")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                    ToolbarItem(placement: .topBarTrailing) { Button("Reload", systemImage: "arrow.clockwise") { web.reload() } }
                }
                .onAppear { web.show(server: model.server, hash: "#office") }
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

struct CanvasWebView: UIViewRepresentable {
    let web: CanvasWeb
    func makeUIView(context: Context) -> WKWebView { web.webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
