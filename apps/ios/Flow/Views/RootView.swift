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
        case board, canvas, settings
    }

    @State private var section: Section = {
        #if DEBUG
        // UI testing: `-startTab canvas` or `-startTab settings`.
        switch UserDefaults.standard.string(forKey: "startTab") {
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
            Tab("Board", systemImage: "rectangle.split.3x1", value: .board) {
                BoardScreen()
            }
            Tab("Flow", systemImage: "point.3.connected.trianglepath.dotted", value: .canvas) {
                CanvasScreen()
            }
            Tab("Settings", systemImage: "gearshape", value: .settings) {
                SettingsScreen()
            }
        }
        .tabViewStyle(.sidebarAdaptable)
    }
}
