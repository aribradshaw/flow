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
    // A notification or widget tap waiting to be shown (MainView takes it).
    var route: AppRoute?
    var showingSettings = false
    var api: FlowAPI? { credential.map(FlowAPI.init) }

    init() {
        let saved = UserDefaults.standard.string(forKey: "server").flatMap(URL.init(string:))
        #if DEBUG
        // UI testing: `-resetSignIn YES` starts signed out.
        if UserDefaults.standard.bool(forKey: "resetSignIn") { Keychain.delete() }
        #endif
        let stored = Keychain.load()
        credential = stored
        server = stored?.server ?? saved ?? Self.defaultServer
        envID = UserDefaults.standard.string(forKey: "env")
    }

    func signedIn(_ credential: Credential) {
        Keychain.save(credential)
        server = credential.server
        self.credential = credential
        Task { await PushManager.shared.sync() }
    }

    func signOut() async {
        guard let credential else { return }
        await PushManager.shared.forget(credential)
        Keychain.delete()
        self.credential = nil
        envs = []
        envsLoaded = false
        InboxStore.shared.clear()
        await AuthService(server: credential.server).signOut(credential)
    }

    // A revoked or expired key: drop it so the sign-in screen comes back.
    // A key from before device keys existed (device_key_required): sign in again to get one.
    func handle(_ error: Error) {
        if let e = error as? FlowError, e.isUnauthorized || e.code == "device_key_required" {
            Keychain.delete()
            credential = nil
        }
    }

    // Projects and labels per environment, for showing and editing cards anywhere.
    struct EnvMeta: Equatable {
        var projects: [String: FlowProject] = [:]
        var labels: [String: FlowLabel] = [:]
        var people: [String: FlowPerson] = [:]

        // The people on a card; a share member without a person card shows by email.
        func assignees(_ card: FlowCard) -> [FlowPerson] {
            var seen = Set<String>()
            return (card.assignees ?? []).compactMap { a in
                guard seen.insert(a.node).inserted else { return nil }
                if let p = people[a.node] { return p }
                if a.node.hasPrefix("@") { return FlowPerson(id: a.node, name: String(a.node.dropFirst()), image: nil) }
                return nil
            }
        }
        var sortedProjects: [FlowProject] { projects.values.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending } }
        var sortedLabels: [FlowLabel] { labels.values.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending } }
    }
    private(set) var metas: [String: EnvMeta] = [:]

    func setMeta(_ env: String, projects: [FlowProject], labels: [FlowLabel], people: [FlowPerson]? = nil) {
        let next = EnvMeta(projects: Dictionary(projects.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }),
                             labels: Dictionary(labels.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }),
                             people: people.map { Dictionary($0.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }) } ?? metas[env]?.people ?? [:])
        if metas[env] != next { metas[env] = next }
    }

    func meta(_ env: String) async -> EnvMeta {
        if let m = metas[env] { return m }
        guard let api else { return EnvMeta() }
        async let p = api.projects(env: env)
        async let l = api.labels(env: env)
        async let ppl = api.people(env: env)
        if let (projects, labels) = try? await (p, l) { setMeta(env, projects: projects, labels: labels, people: (try? await ppl) ?? []) }
        return metas[env] ?? EnvMeta()
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
