import AuthenticationServices
import Foundation
import UIKit

// Signing the app in, using only routes the Flow server already has:
//   1. A web session for this app's web views:
//      - OneProfileID (passkeys): the device flow (lib/device-signin.mjs). The app starts it from the
//        bridge, opens the approval page in an ASWebAuthenticationSession (Safari, so passkeys and an
//        existing OneProfileID session work), and polls until it is approved.
//      - or email + password (+ two-factor code), the same form the web app posts.
//      - Local mode needs neither.
//   2. With that session, POST /api/keys makes this device its own key (all environments, read and
//      write, one year), which the native views use. It shows up, and can be revoked, in
//      Settings › Connect on the web.
@MainActor
final class AuthService {
    let server: URL
    private let bridge = WebBridge.shared

    init(server: URL) {
        self.server = server
    }

    func session() async throws -> AuthSession {
        let r = try await bridge.fetch(server, "/api/auth/session")
        guard r.status == 200 else { throw FlowError(status: r.status, code: nil, message: r.errorMessage) }
        return try r.decode(AuthSession.self)
    }

    // MARK: OneProfileID (device flow)

    private struct DeviceStart: Decodable {
        let verificationUriComplete: String
        let expiresIn: Int
        let interval: Int
    }

    private struct DevicePoll: Decodable {
        let status: String?
        let interval: Int?
        let retryIn: Int?
        let user: SessionUser?
        let error: String?
    }

    func signInWithOneProfileID() async throws -> SessionUser {
        let started = try await bridge.fetch(server, "/api/auth/device/start", method: "POST", body: [:])
        guard started.status == 200, let start = try? started.decode(DeviceStart.self), let link = URL(string: start.verificationUriComplete) else {
            throw FlowError(status: started.status, code: nil, message: started.errorMessage)
        }
        let approval = ApprovalSheet(url: link)
        approval.present()
        defer { approval.close() }

        let deadline = Date().addingTimeInterval(TimeInterval(start.expiresIn))
        var wait = start.interval
        while Date() < deadline {
            try await Task.sleep(for: .seconds(max(1, wait)))
            if approval.dismissedByUser {
                _ = try? await bridge.fetch(server, "/api/auth/device/cancel", method: "POST", body: [:])
                throw CancellationError()
            }
            let r = try await bridge.fetch(server, "/api/auth/device/poll", method: "POST", body: [:])
            let poll = try? r.decode(DevicePoll.self)
            switch poll?.status {
            case "pending":
                wait = poll?.retryIn ?? poll?.interval ?? wait
            case "done":
                if let user = poll?.user { return user }
                throw FlowError(status: r.status, code: nil, message: "Sign-in did not complete. Try again.")
            default:
                throw FlowError(status: r.status, code: nil, message: poll?.error ?? r.errorMessage)
            }
        }
        throw FlowError(status: 410, code: "expired", message: "The sign-in expired. Try again.")
    }

    // MARK: Email and password

    enum PasswordStep {
        case done(SessionUser)
        case twoFactor
    }

    private struct SignInReply: Decodable {
        let user: SessionUser?
        let step: String?
        let error: String?
    }

    func signIn(email: String, password: String) async throws -> PasswordStep {
        try await passwordStep(bridge.fetch(server, "/api/auth/sign-in", method: "POST", body: ["email": email, "password": password]))
    }

    func verify(code: String, trustDevice: Bool) async throws -> PasswordStep {
        try await passwordStep(bridge.fetch(server, "/api/auth/two-factor", method: "POST", body: ["code": code, "trust": trustDevice]))
    }

    private func passwordStep(_ r: WebBridge.Response) throws -> PasswordStep {
        let reply = try? r.decode(SignInReply.self)
        if r.status == 200, let user = reply?.user { return .done(user) }
        if r.status == 200, reply?.step == "verify" { return .twoFactor }
        throw FlowError(status: r.status, code: nil, message: reply?.error ?? r.errorMessage)
    }

    // MARK: The app's key

    private struct KeyReply: Decodable {
        let key: String
        let apiKey: KeyRecord
        struct KeyRecord: Decodable {
            let id: String
            let prefix: String?
        }
    }

    private struct KeyList: Decodable {
        let keys: [Listed]
        struct Listed: Decodable {
            let id: String
            let name: String
            let revokedAt: String?
        }
    }

    // Needs the web session from one of the sign-ins above (or local mode). This device's earlier
    // keys (same name) are revoked first, so signing in again never piles up keys.
    func makeCredential(for user: SessionUser) async throws -> Credential {
        let name = "Flow app · \(UIDevice.current.model) \(Keychain.deviceID)"
        if let listed = try? await bridge.fetch(server, "/api/keys"), listed.status == 200, let list = try? listed.decode(KeyList.self) {
            for old in list.keys where old.name == name && old.revokedAt == nil {
                _ = try? await bridge.fetch(server, "/api/keys/\(seg(old.id))", method: "DELETE")
            }
        }
        let r = try await bridge.fetch(server, "/api/keys", method: "POST",
                                       body: ["name": name, "env": "*", "scopes": ["write"], "expiresInDays": 365])
        guard r.status == 201, let reply = try? r.decode(KeyReply.self) else {
            throw FlowError(status: r.status, code: nil, message: r.errorMessage)
        }
        return Credential(server: server, key: reply.key, keyId: reply.apiKey.id, email: user.email, prefix: reply.apiKey.prefix)
    }

    // Revoke the app's key, end the web session and forget both. Best effort on the server side.
    func signOut(_ credential: Credential) async {
        if let id = credential.keyId {
            _ = try? await bridge.fetch(server, "/api/keys/\(seg(id))", method: "DELETE")
        }
        _ = try? await bridge.fetch(server, "/api/auth/sign-out", method: "POST", body: [:])
        await bridge.clearWebsiteData()
    }
}

// The OneProfileID approval page in an ASWebAuthenticationSession. It never calls back (the device
// flow finishes by polling), so the app closes it once the poll says done.
@MainActor
private final class ApprovalSheet: NSObject, ASWebAuthenticationPresentationContextProviding {
    private let url: URL
    private var session: ASWebAuthenticationSession?
    private var closing = false
    private(set) var dismissedByUser = false

    init(url: URL) {
        self.url = url
    }

    func present() {
        let s = ASWebAuthenticationSession(url: url, callback: .customScheme("flowapp")) { [weak self] _, _ in
            Task { @MainActor in
                guard let self, !self.closing else { return }
                self.dismissedByUser = true
            }
        }
        s.presentationContextProvider = self
        s.prefersEphemeralWebBrowserSession = false
        session = s
        s.start()
    }

    func close() {
        closing = true
        session?.cancel()
        session = nil
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap(\.windows)
                .first(where: \.isKeyWindow) ?? ASPresentationAnchor()
        }
    }
}
