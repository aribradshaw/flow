import Foundation

struct FlowError: LocalizedError {
    let status: Int
    let code: String?
    let message: String

    var errorDescription: String? { message }

    // Board gates on cards.move (docs/api.md "Board gates").
    var isGate: Bool { status == 409 && ["confirm_done", "confirm_reopen", "pick_developer"].contains(code ?? "") }
    var isUnauthorized: Bool { status == 401 || code == "invalid_token" }
}

private struct ErrorBody: Decodable {
    let error: String?
    let code: String?
}

// Flow REST API v1 with the app's API key (Authorization: Bearer flow_…).
struct FlowAPI {
    let credential: Credential

    private static let decoder = JSONDecoder()
    private static let encoder = JSONEncoder()

    func envs() async throws -> [FlowEnv] {
        try await all("/api/v1/envs")
    }

    func projects(env: String) async throws -> [FlowProject] {
        try await all("/api/v1/envs/\(seg(env))/projects")
    }

    func labels(env: String) async throws -> [FlowLabel] {
        try await all("/api/v1/envs/\(seg(env))/labels")
    }

    func cards(env: String, project: String?) async throws -> [FlowCard] {
        var query = [URLQueryItem]()
        if let project { query.append(URLQueryItem(name: "project", value: project)) }
        return try await all("/api/v1/envs/\(seg(env))/cards", query: query)
    }

    func card(env: String, card: String) async throws -> FlowCard {
        let out: CardEnvelope = try await request("GET", "/api/v1/envs/\(seg(env))/cards/\(seg(card))")
        return out.card
    }

    struct Move: Encodable {
        let column: String
        var confirm: Bool?
        var approve: Bool?
        var ifUpdated: String?
    }

    func move(env: String, card: String, _ move: Move) async throws -> FlowCard {
        let out: CardEnvelope = try await request("POST", "/api/v1/envs/\(seg(env))/cards/\(seg(card))/move", body: move)
        return out.card
    }

    // Every page of a list (limit 200, following nextCursor).
    private func all<Item: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> [Item] {
        var items = [Item](), cursor: String?
        repeat {
            var q = query + [URLQueryItem(name: "limit", value: "200")]
            if let cursor { q.append(URLQueryItem(name: "cursor", value: cursor)) }
            let page: Page<Item> = try await request("GET", path, query: q)
            items += page.items
            cursor = page.nextCursor
        } while cursor != nil
        return items
    }

    private func request<Out: Decodable, In: Encodable>(_ method: String, _ path: String, body: In) async throws -> Out {
        try await request(method, path, data: try Self.encoder.encode(body))
    }

    private func request<Out: Decodable>(_ method: String, _ path: String, query: [URLQueryItem] = [], data body: Data? = nil) async throws -> Out {
        guard var parts = URLComponents(url: credential.server, resolvingAgainstBaseURL: false) else {
            throw FlowError(status: 0, code: nil, message: "The server address is not valid.")
        }
        parts.percentEncodedPath = path
        parts.queryItems = query.isEmpty ? nil : query
        guard let url = parts.url else { throw FlowError(status: 0, code: nil, message: "The server address is not valid.") }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(credential.key)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = body
        }
        let (data, response) = try await URLSession.shared.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let err = try? Self.decoder.decode(ErrorBody.self, from: data)
            throw FlowError(status: status, code: err?.code, message: err?.error ?? "Flow answered \(status).")
        }
        return try Self.decoder.decode(Out.self, from: data)
    }
}

// One path segment, percent-encoded (card ids from shares contain dots; names may contain anything).
func seg(_ s: String) -> String {
    s.addingPercentEncoding(withAllowedCharacters: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? s
}
