import SwiftUI

// The welcome screen: Flow's mark, one obvious way in (OneProfileID), email as the alternative, and the
// server tucked away for people who host their own Flow.
struct SignInView: View {
    @Environment(AppModel.self) private var model

    @State private var serverText = ""
    @State private var session: AuthSession?
    @State private var checking = false
    @State private var busy = false
    @State private var error: String?
    @State private var showEmail = false
    @State private var showServer = false

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            VStack(spacing: 14) {
                FlowMark(size: 76)
                Text("Flygon Flow")
                    .font(.title.weight(.semibold))
                    .foregroundStyle(Theme.ink)
                Text("Your board, your agents and everything\nwaiting on you, in your pocket.")
                    .font(.callout)
                    .foregroundStyle(Theme.muted)
                    .multilineTextAlignment(.center)
            }
            Spacer()
            VStack(spacing: 12) {
                if let error {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundStyle(Theme.danger)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                        .padding(.bottom, 4)
                        .transition(.opacity)
                }
                primary
                if let session, session.mode != "local" {
                    Button {
                        showEmail = true
                    } label: {
                        Text("Sign in with email")
                    }
                    .buttonStyle(.flow(.secondary, large: true))
                    .disabled(busy)
                }
                Button {
                    showServer = true
                } label: {
                    HStack(spacing: 4) {
                        Text(serverLabel).foregroundStyle(Theme.muted)
                        Text("Change").fontWeight(.semibold).foregroundStyle(Theme.accent)
                    }
                    .font(.footnote)
                }
                .padding(.top, 6)
                Text("Signing in gives this device its own key. You can revoke it on the web under Settings › Connect.")
                    .font(.caption2)
                    .foregroundStyle(Theme.faint)
                    .multilineTextAlignment(.center)
                    .padding(.top, 2)
            }
            .frame(maxWidth: 420)
            .padding(.horizontal, 24)
            .padding(.bottom, 20)
        }
        .frame(maxWidth: .infinity)
        .background {
            ZStack {
                Theme.bg
                // The mind map's dot grid, faintly, behind the welcome.
                Canvas { ctx, size in
                    var p = Path()
                    for x in stride(from: 8.0, to: size.width, by: 16) {
                        for y in stride(from: 8.0, to: size.height, by: 16) { p.addEllipse(in: CGRect(x: x - 0.8, y: y - 0.8, width: 1.6, height: 1.6)) }
                    }
                    ctx.fill(p, with: .color(Theme.dots.opacity(0.7)))
                }
            }
            .ignoresSafeArea()
        }
        .sheet(isPresented: $showEmail) {
            if let auth { EmailSignIn(auth: auth) { user in await finish(user) } }
        }
        .sheet(isPresented: $showServer) {
            ServerSheet(serverText: $serverText) { Task { await check() } }
        }
        .task {
            if serverText.isEmpty { serverText = Self.display(model.server) }
            await check()
            #if DEBUG
            // UI testing: `-autoSignIn YES` continues as an already signed-in (or local-mode) user.
            if UserDefaults.standard.bool(forKey: "autoSignIn"), let user = session?.user { await finish(user) }
            #endif
        }
    }

    @ViewBuilder
    private var primary: some View {
        let label: String = {
            if let user = session?.user { return "Continue as \(user.name ?? user.email)" }
            if session?.mode == "local" { return "Continue" }
            if session?.device == true { return "Continue with OneProfileID" }
            return "Sign in"
        }()
        Button {
            Task {
                if let user = session?.user { await finish(user) }
                else if session?.device == true { await run { try await $0.signInWithOneProfileID() } }
                else { showEmail = true }
            }
        } label: {
            ZStack {
                Text(label).opacity(busy || checking ? 0 : 1)
                if busy || checking { ProgressView().tint(.white) }
            }
        }
        .buttonStyle(.flow(.primary, large: true))
        .disabled(busy || checking || session == nil)
    }

    private var serverLabel: String {
        if checking { return "Connecting to \(serverText)…" }
        if session == nil { return "Can't reach \(serverText)." }
        return serverText == Self.display(AppModel.defaultServer) ? "Flygon Flow" : serverText
    }

    private static func display(_ url: URL) -> String {
        guard let host = url.host(percentEncoded: false) else { return url.absoluteString }
        return url.port.map { "\(host):\($0)" } ?? host
    }

    private var auth: AuthService? { normalizedServer(serverText).map(AuthService.init) }

    private func check() async {
        withAnimation { error = nil }
        session = nil
        guard let auth else {
            if !serverText.isEmpty { error = "That isn't a server address. Try flow.flygonlc.com." }
            return
        }
        checking = true
        defer { checking = false }
        do { session = try await auth.session() } catch { withAnimation { self.error = error.localizedDescription } }
    }

    private func finish(_ user: SessionUser) async {
        await run { _ in user }
    }

    // Runs one sign-in step; a user it returns gets this device's key.
    private func run(_ step: (AuthService) async throws -> SessionUser?) async {
        guard let auth else { return }
        withAnimation { error = nil }
        busy = true
        defer { busy = false }
        do {
            guard let user = try await step(auth) else { return }
            model.signedIn(try await auth.makeCredential(for: user))
        } catch is CancellationError {
        } catch {
            withAnimation { self.error = error.localizedDescription }
        }
    }
}

// Email, password and (when asked) the authenticator code.
private struct EmailSignIn: View {
    @Environment(\.dismiss) private var dismiss
    let auth: AuthService
    let done: (SessionUser) async -> Void

    @State private var email = ""
    @State private var password = ""
    @State private var needsCode = false
    @State private var code = ""
    @State private var trustDevice = true
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focus: Field?

    private enum Field { case email, password, code }

    var body: some View {
        NavigationStack {
            Form {
                if needsCode {
                    Section {
                        TextField("123456", text: $code)
                            .textContentType(.oneTimeCode)
                            .keyboardType(.numberPad)
                            .font(.title2.monospacedDigit())
                            .focused($focus, equals: .code)
                        Toggle("Trust this device", isOn: $trustDevice)
                    } header: {
                        Text("Authenticator code")
                    } footer: {
                        Text("Enter the code from your authenticator app, or a recovery code.")
                    }
                } else {
                    Section {
                        TextField("Email", text: $email)
                            .textContentType(.username)
                            .keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .focused($focus, equals: .email)
                            .submitLabel(.next)
                            .onSubmit { focus = .password }
                        SecureField("Password", text: $password)
                            .textContentType(.password)
                            .focused($focus, equals: .password)
                            .submitLabel(.go)
                            .onSubmit { Task { await submit() } }
                    }
                }
                if let error {
                    Section { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red).font(.footnote) }
                }
            }
            .navigationTitle(needsCode ? "Two-factor" : "Sign in with email")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if busy { ProgressView() } else {
                        Button(needsCode ? "Verify" : "Sign in") { Task { await submit() } }
                            .disabled(needsCode ? code.count < 4 : email.isEmpty || password.isEmpty)
                    }
                }
            }
            .onAppear { focus = .email }
        }
        .presentationDetents([.medium, .large])
    }

    private func submit() async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            let step = needsCode ? try await auth.verify(code: code, trustDevice: trustDevice) : try await auth.signIn(email: email, password: password)
            switch step {
            case .done(let user):
                await done(user)
                dismiss()
            case .twoFactor:
                withAnimation { needsCode = true }
                focus = .code
            }
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// Another Flow server, or (for testing) an API key.
private struct ServerSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var model
    @Binding var serverText: String
    let onChange: () -> Void
    @State private var draft = ""
    @State private var pastedKey = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("flow.flygonlc.com", text: $draft)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Use Flygon Flow") { draft = "flow.flygonlc.com" }
                } header: {
                    Text("Server")
                } footer: {
                    Text("Only change this if you run your own Flow.")
                }
                Section {
                    SecureField("flow_live_…", text: $pastedKey)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Use this key") {
                        guard let server = normalizedServer(draft) else { return }
                        model.signedIn(Credential(server: server, key: pastedKey.trimmingCharacters(in: .whitespaces), keyId: nil, email: nil, prefix: String(pastedKey.prefix(18))))
                        dismiss()
                    }
                    .disabled(!pastedKey.hasPrefix("flow_"))
                } header: {
                    Text("API key (for testing)")
                } footer: {
                    Text("Notifications, the inbox and the map need a normal sign-in.")
                }
            }
            .navigationTitle("Server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Connect") { serverText = draft; onChange(); dismiss() }
                        .disabled(normalizedServer(draft) == nil)
                }
            }
            .onAppear { draft = serverText }
        }
    }
}
