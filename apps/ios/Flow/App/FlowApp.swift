import SwiftUI

@main
struct FlowApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .onOpenURL { url in if let route = AppRoute(url: url) { model.route = route } }
                .task {
                    PushManager.shared.onRoute = { route in model.route = route }
                    await PushManager.shared.refreshRegistration()
                }
        }
        .onChange(of: scenePhase) { if scenePhase == .background { BackgroundRefresh.schedule() } }
    }
}
