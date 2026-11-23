import Foundation
import Observation

// One environment's board: its cards, projects and labels.
@MainActor
@Observable
final class BoardStore {
    private(set) var cards: [FlowCard] = []
    private(set) var projects: [String: FlowProject] = [:]
    private(set) var labels: [String: FlowLabel] = [:]
    private(set) var loading = false
    private(set) var loadedEnv: String?
    var projectFilter: String?

    func cards(in column: BoardColumn) -> [FlowCard] {
        cards.filter { $0.column == column.rawValue }
    }

    var sortedProjects: [FlowProject] {
        projects.values.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    func load(_ api: FlowAPI, env: String) async throws {
        if loadedEnv != env {
            cards = []
            projectFilter = nil
        }
        loading = true
        defer { loading = false }
        async let c = api.cards(env: env, project: projectFilter)
        async let p = api.projects(env: env)
        async let l = api.labels(env: env)
        let (cards, projects, labels) = try await (c, p, l)
        self.cards = cards
        self.projects = Dictionary(projects.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        self.labels = Dictionary(labels.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        loadedEnv = env
    }

    // Moves a card. A board gate (confirm Done, reopen, no developer) comes back as a FlowError with
    // isGate; the caller asks the person and calls again with confirm or approve.
    @discardableResult
    func move(_ api: FlowAPI, env: String, card: FlowCard, to column: BoardColumn, confirm: Bool = false, approve: Bool = false) async throws -> FlowCard {
        var body = FlowAPI.Move(column: column.rawValue, ifUpdated: card.updated)
        if confirm { body.confirm = true }
        if approve { body.approve = true }
        let moved = try await api.move(env: env, card: card.id, body)
        replace(moved)
        return moved
    }

    func replace(_ card: FlowCard) {
        if let i = cards.firstIndex(where: { $0.id == card.id }) { cards[i] = card } else { cards.append(card) }
    }
}
