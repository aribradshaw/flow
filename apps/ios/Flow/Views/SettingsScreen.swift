import SwiftUI
import UserNotifications

struct SettingsScreen: View {
    @Environment(AppModel.self) private var model
    @State private var confirmSignOut = false
    @State private var push = PushManager.shared
    @State private var status: UNAuthorizationStatus = .notDetermined
    @State private var agentsOn = PushManager.shared.agentsOn
    @State private var cardsOn = PushManager.shared.cardsOn
    @State private var signingOut = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Account") {
                    if let email = model.credential?.email {
                        LabeledContent("Signed in as", value: email)
                    }
                    LabeledContent("Server", value: model.server.host(percentEncoded: false) ?? model.server.absoluteString)
                    if let prefix = model.credential?.prefix {
                        LabeledContent("This device's key", value: prefix + "…")
                    }
                }
                Section {
                    switch status {
                    case .authorized, .provisional, .ephemeral:
                        Toggle("When an agent is waiting on you", isOn: $agentsOn)
                            .onChange(of: agentsOn) { push.agentsOn = agentsOn }
                        Toggle("When a card is assigned to you or moves", isOn: $cardsOn)
                            .onChange(of: cardsOn) { push.cardsOn = cardsOn }
                    case .denied:
                        Button("Turn on in iOS Settings") {
                            if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
                        }
                    default:
                        Button("Turn on notifications") {
                            Task { await push.enable(); status = await push.authorization() }
                        }
                    }
                } header: {
                    Text("Notifications")
                } footer: {
                    if InboxStore.shared.pushEnabledOnServer == false {
                        Text("This Flow server doesn't send notifications yet (APNs isn't set up), so these settings take effect once it does.")
                    } else if let error = push.lastError {
                        Text(error)
                    }
                }
                Section {
                    Link(destination: model.server) {
                        Label("Open Flow in Safari", systemImage: "safari")
                    }
                }
                Section {
                    Button("Sign out", role: .destructive) { confirmSignOut = true }
                        .disabled(signingOut)
                } footer: {
                    Text("Signing out revokes this device's key and ends its web session.")
                }
                Section {
                    LabeledContent("Version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")
                }
            }
            .navigationTitle("Settings")
            .task { status = await push.authorization() }
            .confirmationDialog("Sign out of Flow on this device?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) {
                    signingOut = true
                    Task { await model.signOut(); signingOut = false }
                }
            }
        }
    }
}
