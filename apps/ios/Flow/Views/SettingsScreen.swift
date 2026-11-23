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

    private var notificationFooter: String {
        if InboxStore.shared.pushEnabledOnServer == false { return "This Flow server doesn't send notifications yet. These take effect once it does." }
        if let error = push.lastError { return error }
        return "Answer an agent right from the notification: Allow, Deny or Reply."
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    HStack(spacing: 14) {
                        Avatar(name: model.credential?.displayName ?? "Flow", size: 48, ring: false)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(model.credential?.name ?? model.credential?.email ?? "Signed in with a key").font(.headline).foregroundStyle(Theme.ink)
                            if model.credential?.name != nil, let email = model.credential?.email {
                                Text(email).font(.subheadline).foregroundStyle(Theme.muted)
                            }
                            if model.server != AppModel.defaultServer {
                                Text(model.server.host(percentEncoded: false) ?? model.server.absoluteString).font(.caption).foregroundStyle(Theme.faint)
                            }
                        }
                        Spacer()
                    }
                    .padding(14)
                    .background(Theme.surface, in: .rect(cornerRadius: Theme.panelCorner))
                    .overlay(RoundedRectangle(cornerRadius: Theme.panelCorner).strokeBorder(Theme.line))

                    if InboxStore.shared.pushEnabledOnServer != false {
                    FlowGroup(title: "Notifications", footer: notificationFooter) {
                        switch status {
                        case .authorized, .provisional, .ephemeral:
                            FlowRow(icon: "hand.raised", title: "Agents waiting on you") {
                                Toggle("", isOn: $agentsOn).labelsHidden().tint(Theme.green)
                                    .onChange(of: agentsOn) { push.agentsOn = agentsOn }
                            }
                            FlowRow(icon: "rectangle.split.3x1", title: "Cards assigned or moved") {
                                Toggle("", isOn: $cardsOn).labelsHidden().tint(Theme.green)
                                    .onChange(of: cardsOn) { push.cardsOn = cardsOn }
                            }
                        case .denied:
                            Button {
                                if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
                            } label: {
                                FlowRow(icon: "bell.slash", title: "Turn on in iOS Settings") {
                                    Image(systemName: "arrow.up.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.faint)
                                }
                            }
                            .buttonStyle(.plain)
                        default:
                            Button {
                                Task { await push.enable(); status = await push.authorization() }
                            } label: {
                                FlowRow(icon: "bell.badge", title: "Turn on notifications", tint: Theme.accent) {
                                    Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.faint)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }

                    }

                    FlowGroup(title: "This device", footer: "This device has its own key, listed in Flow under Settings › Connect, where you can revoke it.") {
                        Link(destination: model.server) {
                            FlowRow(icon: "safari", title: "Open Flow on the web") {
                                Image(systemName: "arrow.up.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.faint)
                            }
                        }
                        .buttonStyle(.plain)
                        if let prefix = model.credential?.prefix {
                            FlowRow(icon: "checkmark.shield", title: "Signed in") {
                                Text("Connected").font(.subheadline).foregroundStyle(Theme.muted)
                            }
                            .contextMenu { Button("Copy key prefix", systemImage: "doc.on.doc") { UIPasteboard.general.string = prefix } }
                        }
                    }

                    Button(role: .destructive) {
                        confirmSignOut = true
                    } label: {
                        ZStack {
                            Text("Sign out").opacity(signingOut ? 0 : 1)
                            if signingOut { ProgressView() }
                        }
                    }
                    .buttonStyle(.flow(.danger, large: true))
                    .disabled(signingOut)

                    let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
                    let b = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
                    HStack(spacing: 6) {
                        FlowMark(size: 16)
                        Text("Flygon Flow \(v) (\(b))")
                    }
                    .font(.caption)
                    .foregroundStyle(Theme.faint)
                    .frame(maxWidth: .infinity)
                }
                .padding()
                .frame(maxWidth: 560)
                .frame(maxWidth: .infinity)
            }
            .background(Theme.bg)
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
