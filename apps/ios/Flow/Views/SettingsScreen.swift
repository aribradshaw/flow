import SwiftUI

struct SettingsScreen: View {
    @Environment(AppModel.self) private var model
    @State private var confirmSignOut = false
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
            .confirmationDialog("Sign out of Flow on this device?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) {
                    signingOut = true
                    Task { await model.signOut(); signingOut = false }
                }
            }
        }
    }
}
