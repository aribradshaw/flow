import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if model.credential == nil {
            SignInView()
        } else {
            MainView()
        }
    }
}

// Tabs on iPhone, a sidebar on iPad (.sidebarAdaptable).
struct MainView: View {
    enum Section: Hashable {
        case inbox, board, canvas, settings
    }

    @Environment(AppModel.self) private var model
    @State private var inbox = InboxStore.shared
    @State private var boardPath = NavigationPath()
    @State private var inboxPath = NavigationPath()
    @State private var section: Section = {
        #if DEBUG
        // UI testing: `-startTab inbox`, `canvas` or `settings`.
        switch UserDefaults.standard.string(forKey: "startTab") {
        case "inbox": return .inbox
        case "canvas": return .canvas
        case "settings": return .settings
        default: return .board
        }
        #else
        return .board
        #endif
    }()

    var body: some View {
        TabView(selection: $section) {
            Tab("Inbox", systemImage: "tray", value: .inbox) {
                InboxScreen(path: $inboxPath)
            }
            .badge(inbox.count)
            Tab("Board", systemImage: "rectangle.split.3x1", value: .board) {
                BoardScreen(path: $boardPath)
            }
            Tab("Flow", systemImage: "point.3.connected.trianglepath.dotted", value: .canvas) {
                CanvasScreen()
            }
            Tab("Settings", systemImage: "gearshape", value: .settings) {
                SettingsScreen()
            }
        }
        .tabViewStyle(.sidebarAdaptable)
        .onChange(of: model.route, initial: true) { open(model.route) }
        .task {
            PushManager.shared.onActivity = {
                guard let api = model.api else { return }
                Task { try? await InboxStore.shared.load(api, envs: model.envs) }
            }
            #if DEBUG
            // UI testing: `-openCard <env>/<id>` opens that card as a notification tap would.
            if let ref = UserDefaults.standard.string(forKey: "openCard")?.split(separator: "/", maxSplits: 1), ref.count == 2 {
                model.route = .card(CardRef(env: String(ref[0]), id: String(ref[1])))
            }
            #endif
        }
    }

    // A notification or widget tap: the inbox, or the card (on the inbox's stack, wherever it lives).
    private func open(_ route: AppRoute?) {
        guard let route else { return }
        model.route = nil
        switch route {
        case .inbox:
            section = .inbox
        case .card(let ref):
            section = .inbox
            inboxPath = NavigationPath()
            inboxPath.append(ref)
        }
    }
}
