import SwiftUI
import UserNotifications

struct SettingsScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var confirmSignOut = false
    @State private var signingOut = false
    @State private var push = PushManager.shared
    @State private var status: UNAuthorizationStatus = .notDetermined
    @State private var agentsOn = PushManager.shared.agentsOn
    @State private var cardsOn = PushManager.shared.cardsOn

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 14) {
                        Avatar(name: model.credential?.email ?? "Flow", size: 52)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(model.credential?.email ?? "Signed in with a key").font(.headline)
                            Text(model.server.host(percentEncoded: false) ?? model.server.absoluteString).font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                }

                Section {
                    switch status {
                    case .authorized, .provisional, .ephemeral:
                        Toggle(isOn: $agentsOn) {
                            Label("Agents waiting on you", systemImage: "hand.raised.fill")
                        }
                        .onChange(of: agentsOn) { push.agentsOn = agentsOn }
                        Toggle(isOn: $cardsOn) {
                            Label("Cards assigned or moved", systemImage: "rectangle.split.3x1.fill")
                        }
                        .onChange(of: cardsOn) { push.cardsOn = cardsOn }
                    case .denied:
                        Button {
                            if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
                        } label: {
                            Label("Turn on in iOS Settings", systemImage: "bell.slash")
                        }
                    default:
                        Button {
                            Task { await push.enable(); status = await push.authorization() }
                        } label: {
                            Label("Turn on notifications", systemImage: "bell.badge")
                        }
                    }
                } header: {
                    Text("Notifications")
                } footer: {
                    if InboxStore.shared.pushEnabledOnServer == false {
                        Text("This Flow server doesn't send notifications yet. These settings take effect once it does.")
                    } else if let error = push.lastError {
                        Text(error)
                    } else {
                        Text("Answer an agent right from the notification: Allow, Deny or Reply.")
                    }
                }

                Section {
                    Link(destination: model.server) {
                        Label("Open Flow in Safari", systemImage: "safari")
                    }
                    if let prefix = model.credential?.prefix {
                        LabeledContent {
                            Text(prefix + "…").font(.caption.monospaced())
                        } label: {
                            Label("This device's key", systemImage: "key")
                        }
                    }
                } footer: {
                    Text("This iPhone has its own key, listed in Flow under Settings › Connect, where you can revoke it.")
                }

                Section {
                    Button(role: .destructive) {
                        confirmSignOut = true
                    } label: {
                        HStack {
                            Spacer()
                            if signingOut { ProgressView() } else { Text("Sign out") }
                            Spacer()
                        }
                    }
                    .disabled(signingOut)
                }

                Section {
                } footer: {
                    let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
                    let b = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
                    Text("Flow \(v) (\(b))").frame(maxWidth: .infinity)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { status = await push.authorization() }
            .confirmationDialog("Sign out of Flow on this device?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) {
                    signingOut = true
                    Task { await model.signOut(); signingOut = false; dismiss() }
                }
            } message: {
                Text("This device's key is revoked, so you'll sign in again next time.")
            }
        }
    }
}
