import SwiftUI

struct SignInView: View {
    @Environment(AppModel.self) private var model

    @State private var serverText = ""
    @State private var session: AuthSession?
    @State private var checking = false
    @State private var busy = false
    @State private var error: String?

    @State private var showPassword = false
    @State private var email = ""
    @State private var password = ""
    @State private var needsCode = false
    @State private var code = ""
    @State private var trustDevice = true

    @State private var showKey = false
    @State private var pastedKey = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(spacing: 8) {
                        Image(systemName: "point.3.connected.trianglepath.dotted")
                            .font(.system(size: 44, weight: .semibold))
                            .foregroundStyle(.tint)
                        Text("Flow")
                            .font(.largeTitle.bold())
                        Text("Mind maps, timelines and your DevOps board.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .listRowBackground(Color.clear)
                }

                Section {
                    TextField("flow.flygonlc.com", text: $serverText)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onSubmit { Task { await check() } }
                } header: {
                    Text("Server")
                } footer: {
                    if checking {
                        Text("Connecting…")
                    } else if let session {
                        Text(session.mode == "local" ? "This server runs in local mode: no sign-in needed." : "Connected.")
                    }
                }

                if let session { signInSection(session) }

                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    DisclosureGroup("Use an API key instead", isExpanded: $showKey) {
                        SecureField("flow_live_…", text: $pastedKey)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Button("Use this key") { useKey() }
                            .disabled(!pastedKey.hasPrefix("flow_") || busy)
                    }
                } footer: {
                    Text("For testing. Make a key in Flow under Settings › Connect. The mind map and timeline still ask you to sign in on the web.")
                }
            }
            .disabled(busy)
            .overlay { if busy { ProgressView().controlSize(.large) } }
            .navigationTitle("Sign in")
            .navigationBarTitleDisplayMode(.inline)
            .task {
                if serverText.isEmpty { serverText = model.server.host(percentEncoded: false).map { host in
                    model.server.port.map { "\(host):\($0)" } ?? host
                } ?? "" }
                await check()
                #if DEBUG
                // UI testing: `-autoSignIn YES` continues as an already signed-in (or local-mode) user.
                if UserDefaults.standard.bool(forKey: "autoSignIn"), let user = session?.user { await finish(user) }
                #endif
            }
        }
    }

    @ViewBuilder
    private func signInSection(_ session: AuthSession) -> some View {
        Section {
            if let user = session.user {
                Button {
                    Task { await finish(user) }
                } label: {
                    Label("Continue as \(user.name ?? user.email)", systemImage: "person.crop.circle.badge.checkmark")
                }
            }
            if session.mode != "local" {
                if session.device == true {
                    Button {
                        Task { await oneProfileID() }
                    } label: {
                        Label("Continue with OneProfileID", systemImage: "person.badge.key")
                    }
                }
                DisclosureGroup("Sign in with email", isExpanded: $showPassword) {
                    if needsCode {
                        TextField("Code from your authenticator app", text: $code)
                            .textContentType(.oneTimeCode)
                            .keyboardType(.asciiCapable)
                        Toggle("Trust this device", isOn: $trustDevice)
                        Button("Verify") { Task { await verify() } }
                            .disabled(code.count < 4)
                    } else {
                        TextField("Email", text: $email)
                            .textContentType(.username)
                            .keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        SecureField("Password", text: $password)
                            .textContentType(.password)
                        Button("Sign in") { Task { await passwordSignIn() } }
                            .disabled(email.isEmpty || password.isEmpty)
                    }
                }
            }
        } footer: {
            if session.mode != "local" {
                Text("Signing in makes a key for this device, named \"Flow app\". You can revoke it on the web under Settings › Connect.")
            }
        }
    }

    private var auth: AuthService? {
        normalizedServer(serverText).map(AuthService.init)
    }

    private func check() async {
        error = nil
        session = nil
        guard let auth else {
            if !serverText.isEmpty { error = "Enter a server address such as flow.flygonlc.com." }
            return
        }
        checking = true
        defer { checking = false }
        do { session = try await auth.session() } catch { self.error = error.localizedDescription }
    }

    private func oneProfileID() async {
        await run { auth in try await auth.signInWithOneProfileID() }
    }

    private func passwordSignIn() async {
        await run { auth in
            switch try await auth.signIn(email: email, password: password) {
            case .done(let user): return user
            case .twoFactor: needsCode = true; return nil
            }
        }
    }

    private func verify() async {
        await run { auth in
            switch try await auth.verify(code: code, trustDevice: trustDevice) {
            case .done(let user): return user
            case .twoFactor: return nil
            }
        }
    }

    private func finish(_ user: SessionUser) async {
        await run { _ in user }
    }

    // Runs one sign-in step; a user it returns gets this device's key.
    private func run(_ step: (AuthService) async throws -> SessionUser?) async {
        guard let auth else { return }
        error = nil
        busy = true
        defer { busy = false }
        do {
            guard let user = try await step(auth) else { return }
            model.signedIn(try await auth.makeCredential(for: user))
        } catch is CancellationError {
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func useKey() {
        guard let server = normalizedServer(serverText) else { return }
        model.signedIn(Credential(server: server, key: pastedKey.trimmingCharacters(in: .whitespaces), keyId: nil, email: nil, prefix: String(pastedKey.prefix(18))))
    }
}
