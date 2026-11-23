import Foundation
import Observation

// App-wide state: the server, the app's credential, and the environment being shown.
@MainActor
@Observable
final class AppModel {
    static let defaultServer = URL(string: "https://flow.flygonlc.com")!

    private(set) var credential: Credential?
    var server: URL {
        didSet { UserDefaults.standard.set(server.absoluteString, forKey: "server") }
    }

    private(set) var envs: [FlowEnv] = []
    private(set) var envsLoaded = false
    var envID: String? {
        didSet { UserDefaults.standard.set(envID, forKey: "env") }
    }

    var env: FlowEnv? { envs.first { $0.id == envID } }
    var api: FlowAPI? { credential.map(FlowAPI.init) }

    init() {
        let saved = UserDefaults.standard.string(forKey: "server").flatMap(URL.init(string:))
        let stored = Keychain.load()
        credential = stored
        server = stored?.server ?? saved ?? Self.defaultServer
        envID = UserDefaults.standard.string(forKey: "env")
    }

    func signedIn(_ credential: Credential) {
        Keychain.save(credential)
        server = credential.server
        self.credential = credential
    }

    func signOut() async {
        guard let credential else { return }
        Keychain.delete()
        self.credential = nil
        envs = []
        envsLoaded = false
        await AuthService(server: credential.server).signOut(credential)
    }

    // A revoked or expired key: drop it so the sign-in screen comes back.
    func handle(_ error: Error) {
        if let e = error as? FlowError, e.isUnauthorized {
            Keychain.delete()
            credential = nil
        }
    }

    func loadEnvs() async throws {
        guard let api else { return }
        envs = try await api.envs()
        envsLoaded = true
        if env == nil { envID = envs.first?.id }
    }

    // A new environment, through the web session (the REST API has no envs.create).
    func createEnvironment(named name: String) async throws {
        guard let server = credential?.server else { return }
        let r = try await WebBridge.shared.fetch(server, "/api/environments", method: "POST", body: ["name": name])
        struct Created: Decodable { let id: String }
        guard r.status == 200, let created = try? r.decode(Created.self) else {
            throw FlowError(status: r.status, code: nil, message: r.status == 401 ? "Sign in again to create a workspace." : r.errorMessage)
        }
        envID = created.id
        try await loadEnvs()
    }
}

// "flow.example.com" or "localhost:3000" -> a URL with a scheme and no path.
func normalizedServer(_ text: String) -> URL? {
    var t = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if t.isEmpty { return nil }
    if !t.contains("://") {
        let local = t.hasPrefix("localhost") || t.hasPrefix("127.") || t.hasPrefix("192.168.") || t.hasPrefix("10.") || t.contains(".local")
        t = (local ? "http://" : "https://") + t
    }
    guard var parts = URLComponents(string: t), let scheme = parts.scheme, ["http", "https"].contains(scheme), parts.host?.isEmpty == false else { return nil }
    parts.path = ""
    parts.query = nil
    parts.fragment = nil
    return parts.url
}
