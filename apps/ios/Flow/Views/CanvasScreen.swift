import SwiftUI

// The Map tab: the mind map and the timeline, native (MindMapView, TimelineView).
struct CanvasScreen: View {
    enum Mode: Hashable { case map, timeline }

    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
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
    @State private var openNode: FlowNode?
    @State private var searching = false
    @State private var selectedItem: TimelineItem?
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
            .navigationTitle(landscapePhone ? "" : mode == .map ? (map.chart?.name ?? "Mind map") : "Timeline")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .safeAreaInset(edge: .top, spacing: 0) {
                if !landscapePhone { switcherBar }
            }
            .task(id: model.envID) { await load() }
            .onChange(of: map.chartID) { Task { await loadMap() } }
            .refreshable { await load() }
            .sheet(item: $openNode) { n in
                NodeSheet(node: n, nodes: map.nodes, edges: map.edges) { id in
                    // A related card: close this, highlight and fly to it, then open it.
                    guard let next = map.nodes.first(where: { $0.id == id }) else { return }
                    openNode = nil
                    selectedNode = id
                    camera.show(next.rect.insetBy(dx: -120, dy: -90))
                    Task { try? await Task.sleep(for: .milliseconds(450)); openNode = next }
                }
            }
            .sheet(isPresented: $searching) {
                NodeSearch(nodes: map.nodes) { n in
                    searching = false
                    selectedNode = n.id
                    camera.show(n.rect.insetBy(dx: -120, dy: -90))
                }
            }
            .sheet(item: $selectedItem) { ItemSheet(item: $0, store: timeline) }
        }
    }

    private var currentTimelineMode: TimelineMode { timelineMode ?? (sizeClass == .regular || landscapePhone ? .roadmap : .list) }

    // An iPhone on its side: no room for a second bar, so the switchers move into the navigation bar.
    private var landscapePhone: Bool { verticalSizeClass == .compact }

    private var modeSwitcher: some View {
        FlowSegmented(options: [Mode.map, .timeline], selection: $mode, title: { $0 == .map ? "Mind map" : "Timeline" })
    }

    private var timelineSwitcher: some View {
        FlowSegmented(options: TimelineMode.allCases, selection: Binding(get: { currentTimelineMode }, set: { timelineMode = $0 }), title: \.title)
    }

    private var switcherBar: some View {
        HStack {
            modeSwitcher
            Spacer()
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(Theme.bg)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
    }

    @ViewBuilder
    private var mapView: some View {
        if map.nodes.isEmpty {
            if map.loading || map.loadedKey == nil { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) }
            else {
                ContentUnavailableView("This mind map is empty", systemImage: "point.3.connected.trianglepath.dotted",
                                       description: Text(error ?? "Add entities and people to it in Flow on the web."))
            }
        } else {
            MindMapView(nodes: map.nodes, edges: map.edges, selected: $selectedNode, camera: camera) { openNode = $0 }
                .ignoresSafeArea(edges: [.horizontal, .bottom])
                .overlay(alignment: .bottomTrailing) {
                    Button { camera.overview = true; camera.fitRequest += 1 } label: {
                        Image(systemName: "arrow.up.left.and.arrow.down.right").font(.subheadline.weight(.semibold))
                            .foregroundStyle(Theme.ink)
                            .frame(width: 44, height: 44)
                            .background(.regularMaterial, in: .circle)
                            .overlay(Circle().strokeBorder(Theme.line))
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
        if landscapePhone {
            ToolbarItem(placement: .principal) {
                modeSwitcher
            }
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
            if mode == .map && !map.nodes.isEmpty {
                Button { searching = true } label: { Image(systemName: "magnifyingglass") }
                    .accessibilityLabel("Find a card on the map")
            }
            if mode == .timeline || map.charts.count > 1 {
            Menu {
                if mode == .timeline {
                    Picker("View", selection: Binding(get: { currentTimelineMode }, set: { timelineMode = $0 })) {
                        Label("Roadmap", systemImage: "chart.bar.xaxis").tag(TimelineMode.roadmap)
                        Label("List", systemImage: "list.bullet").tag(TimelineMode.list)
                    }
                }
                if mode == .map && map.charts.count > 1 {
                    Picker("Mind map", selection: Binding(get: { map.chartID }, set: { map.chartID = $0 })) {
                        ForEach(map.charts) { c in Text(c.name).tag(Optional(c.id)) }
                    }
                }
            } label: {
                Image(systemName: mode == .timeline ? "slider.horizontal.3" : "rectangle.stack")
            }
            .accessibilityLabel(mode == .timeline ? "Timeline view" : "Choose a mind map")
            }
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

// Find a card on the map by name (and jump to it).
private struct NodeSearch: View {
    let nodes: [FlowNode]
    let onPick: (FlowNode) -> Void
    @State private var query = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let list = nodes.filter { q.isEmpty || $0.name.lowercased().contains(q) || ($0.notes ?? "").lowercased().contains(q) }
            .sorted { ($0.type == "area" ? 0 : 1, $0.name.lowercased()) < ($1.type == "area" ? 0 : 1, $1.name.lowercased()) }
        NavigationStack {
            List(list) { n in
                Button { onPick(n) } label: {
                    HStack(spacing: 10) {
                        Image(systemName: n.symbol)
                            .foregroundStyle(n.type == "person" ? Theme.person : n.type == "note" ? Theme.note : n.type == "area" ? Theme.faint : Theme.accent)
                            .frame(width: 22)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(n.name).foregroundStyle(Theme.ink).lineLimit(1)
                            Text(n.kindTitle).font(.caption).foregroundStyle(Theme.muted)
                        }
                    }
                }
                .listRowBackground(Theme.surface)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Entities, people, areas, notes")
            .navigationTitle("Find on the map")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }
}
