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
        case inbox, board, canvas
    }

    @Environment(AppModel.self) private var model
    @State private var inbox = InboxStore.shared
    @State private var boardPath = NavigationPath()
    @State private var inboxPath = NavigationPath()
    @State private var section: Section = {
        #if DEBUG
        // UI testing: `-startTab board` or `canvas`.
        switch UserDefaults.standard.string(forKey: "startTab") {
        case "board": return .board
        case "canvas": return .canvas
        default: return .inbox
        }
        #else
        return .inbox
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
            Tab("Map", systemImage: "point.3.connected.trianglepath.dotted", value: .canvas) {
                CanvasScreen()
            }
        }
        .tabViewStyle(.sidebarAdaptable)
        .sheet(isPresented: Binding(get: { model.showingSettings }, set: { model.showingSettings = $0 })) { SettingsScreen() }
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

// The signed-in person, top left of Inbox and Board: opens Settings.
struct ProfileButton: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Button {
            model.showingSettings = true
        } label: {
            Avatar(name: model.credential?.email ?? "Flow", size: 30)
        }
        .accessibilityLabel("Account and settings")
    }
}
