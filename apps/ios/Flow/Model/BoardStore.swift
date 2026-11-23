import Foundation
import Observation

// One environment's board: its cards, projects and labels.
@MainActor
@Observable
final class BoardStore {
    private(set) var cards: [FlowCard] = []
    private(set) var projects: [String: FlowProject] = [:]
    private(set) var labels: [String: FlowLabel] = [:]
    private(set) var people: [FlowPerson] = []
    private(set) var loading = false
    private(set) var loadedEnv: String?
    var projectFilter: String?
    private(set) var lastLoad: Date = .distantPast

    // Coming back to the tab within half a minute does not reload (pull to refresh always does).
    var isFresh: Bool { Date.now.timeIntervalSince(lastLoad) < 30 }

    func cards(in column: BoardColumn) -> [FlowCard] {
        cards.filter { $0.column == column.rawValue }
    }

    var loadedOnce: Bool { loadedEnv != nil }

    var sortedProjects: [FlowProject] {
        projects.values.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    func load(_ api: FlowAPI, env: String) async throws {
        if loadedEnv != env {
            cards = []
            projectFilter = nil
        }
        if !loading { loading = true }
        defer { loading = false }
        async let c = api.cards(env: env, project: projectFilter)
        async let p = api.projects(env: env)
        async let l = api.labels(env: env)
        async let ppl = api.people(env: env)
        let (cards, projects, labels) = try await (c, p, l)
        let fetchedPeople = (try? await ppl) ?? people
        // Only what changed is published, so a refresh with nothing new redraws nothing (no flicker).
        if fetchedPeople != people { people = fetchedPeople }
        if cards != self.cards { self.cards = cards }
        let pd = Dictionary(projects.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        if pd != self.projects { self.projects = pd }
        let ld = Dictionary(labels.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        if ld != self.labels { self.labels = ld }
        if loadedEnv != env { loadedEnv = env }
        lastLoad = .now
    }

    func replace(_ card: FlowCard) {
        if let i = cards.firstIndex(where: { $0.id == card.id }) { cards[i] = card } else { cards.append(card) }
    }
}
