import Foundation
import UIKit
import UserNotifications

// Notifications (docs/ios-app.md): asks for permission, registers this device with Flow, and handles
// Allow / Deny / Reply on an agent's notification and taps that open a card or the inbox.
@MainActor
final class PushManager: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PushManager()

    static let approval = "FLOW_AGENT_APPROVAL", question = "FLOW_AGENT_QUESTION", agent = "FLOW_AGENT", card = "FLOW_CARD"
    static let allow = "FLOW_ALLOW", deny = "FLOW_DENY", reply = "FLOW_REPLY"

    // Set by the app: where a tapped notification goes, and a nudge to reload the inbox.
    var onRoute: ((AppRoute) -> Void)?
    var onActivity: (() -> Void)?

    private let defaults = UserDefaults.standard
    private(set) var lastError: String?

    var token: String? { defaults.string(forKey: "pushToken") }
    var agentsOn: Bool {
        get { defaults.object(forKey: "pushAgents") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "pushAgents"); Task { await sync() } }
    }
    var cardsOn: Bool {
        get { defaults.object(forKey: "pushCards") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "pushCards"); Task { await sync() } }
    }

    func setUp() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let allow = UNNotificationAction(identifier: Self.allow, title: "Allow", options: [.authenticationRequired])
        let deny = UNNotificationAction(identifier: Self.deny, title: "Deny", options: [.authenticationRequired, .destructive])
        let reply = UNTextInputNotificationAction(identifier: Self.reply, title: "Reply", options: [.authenticationRequired],
                                                  textInputButtonTitle: "Send", textInputPlaceholder: "Your answer")
        center.setNotificationCategories([
            UNNotificationCategory(identifier: Self.approval, actions: [allow, deny], intentIdentifiers: []),
            UNNotificationCategory(identifier: Self.question, actions: [reply], intentIdentifiers: []),
            UNNotificationCategory(identifier: Self.agent, actions: [], intentIdentifiers: []),
            UNNotificationCategory(identifier: Self.card, actions: [], intentIdentifiers: []),
        ])
    }

    func authorization() async -> UNAuthorizationStatus {
        await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    // Asks once (the system remembers the answer), then registers with APNs.
    @discardableResult
    func enable() async -> Bool {
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        if granted { UIApplication.shared.registerForRemoteNotifications() }
        return granted
    }

    // Already allowed: register again on launch (tokens can change).
    func refreshRegistration() async {
        let status = await authorization()
        if status == .authorized || status == .provisional || status == .ephemeral {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    func didRegister(_ deviceToken: Data) {
        defaults.set(deviceToken.map { String(format: "%02x", $0) }.joined(), forKey: "pushToken")
        lastError = nil
        Task { await sync() }
    }

    func didFail(_ error: Error) {
        lastError = error.localizedDescription
    }

    // Tells Flow about this device and its preferences.
    func sync() async {
        guard let token, let credential = Keychain.load() else { return }
        #if DEBUG
        let environment = "sandbox"
        #else
        let environment = "production"
        #endif
        do {
            try await FlowAPI(credential: credential).register(.init(token: token, environment: environment, bundle: Bundle.main.bundleIdentifier ?? "",
                                                                     prefs: .init(agents: agentsOn, cards: cardsOn)))
        } catch {
            lastError = error.localizedDescription
        }
    }

    // On sign-out: Flow forgets this device (the key is revoked right after anyway).
    func forget(_ credential: Credential) async {
        guard let token else { return }
        try? await FlowAPI(credential: credential).unregister(token: token)
    }

    // MARK: UNUserNotificationCenterDelegate

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        await MainActor.run { onActivity?() }
        return [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo["flow"] as? [String: Any] ?? [:]
        let action = response.actionIdentifier
        let text = (response as? UNTextInputNotificationResponse)?.userText
        await handle(info: info, action: action, text: text)
    }

    private func handle(info: [String: Any], action: String, text: String?) async {
        let type = info["type"] as? String
        if type == "agent", let source = info["source"] as? String, let agentId = info["agentId"] as? String, let credential = Keychain.load() {
            let api = FlowAPI(credential: credential)
            switch action {
            case Self.allow, Self.deny:
                try? await api.answer(.init(source: source, agentId: agentId, requestId: info["requestId"] as? String, decision: action == Self.allow ? "allow" : "deny"))
                onActivity?()
                return
            case Self.reply:
                if let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    try? await api.answer(.init(source: source, agentId: agentId, kind: "message", text: text))
                }
                onActivity?()
                return
            default:
                break
            }
        }
        guard action == UNNotificationDefaultActionIdentifier else { return }
        if type == "card", let env = info["env"] as? String, let card = info["card"] as? String {
            onRoute?(.card(CardRef(env: env, id: card)))
        } else {
            onRoute?(.inbox)
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        PushManager.shared.setUp()
        BackgroundRefresh.register()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushManager.shared.didRegister(deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        PushManager.shared.didFail(error)
    }
}
