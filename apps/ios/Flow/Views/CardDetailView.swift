import SwiftUI

struct CardDetailView: View {
    @Environment(AppModel.self) private var model
    let board: BoardStore
    let onMove: (FlowCard, BoardColumn) -> Void
    @State private var card: FlowCard

    init(board: BoardStore, card: FlowCard, onMove: @escaping (FlowCard, BoardColumn) -> Void) {
        self.board = board
        self.onMove = onMove
        _card = State(initialValue: card)
    }

    private var column: BoardColumn? { BoardColumn(rawValue: card.column) }

    var body: some View {
        List {
            Section {
                Text(card.title)
                    .font(.title3.weight(.semibold))
                LabeledContent("Column") {
                    Label(column?.title ?? card.column, systemImage: column?.systemImage ?? "square")
                }
                if let id = card.project, let p = board.projects[id] {
                    LabeledContent("Project") {
                        HStack(spacing: 6) {
                            Circle().fill(Color(flow: p.color)).frame(width: 9, height: 9)
                            Text(p.name)
                        }
                    }
                }
                let labels = (card.labels ?? []).compactMap { board.labels[$0] }
                if !labels.isEmpty {
                    LabeledContent("Labels") {
                        HStack(spacing: 4) { ForEach(labels) { LabelChip(label: $0) } }
                    }
                }
                if let points = card.points {
                    LabeledContent("Points", value: points.formatted())
                }
                if let due = card.due, !due.isEmpty {
                    LabeledContent("Due", value: due)
                }
            }

            if let text = card.description, !text.isEmpty {
                Section("Description") {
                    Text(text)
                        .textSelection(.enabled)
                }
            }

            if let items = card.checklist, !items.isEmpty {
                Section("Checklist · \(items.filter(\.done).count)/\(items.count)") {
                    ForEach(items) { item in
                        Label(item.text, systemImage: item.done ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(item.done ? .secondary : .primary)
                    }
                }
            }

            if let links = card.links, !links.isEmpty {
                Section("Links") {
                    ForEach(links, id: \.url) { link in
                        if let url = URL(string: link.url) {
                            Link(destination: url) {
                                Label(link.url, systemImage: link.kind == "pr" ? "arrow.triangle.pull" : link.kind == "commit" ? "smallcircle.filled.circle" : "link")
                                    .lineLimit(1)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle(card.numberText)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    ForEach(BoardColumn.allCases.filter { $0.rawValue != card.column }) { col in
                        Button(col.title, systemImage: col.systemImage) { onMove(card, col) }
                    }
                } label: {
                    Label("Move", systemImage: "arrow.right.square")
                }
            }
        }
        .task { await refresh() }
        .refreshable { await refresh() }
        .onChange(of: board.cards) {
            if let newer = board.cards.first(where: { $0.id == card.id }) { card = newer }
        }
    }

    private func refresh() async {
        guard let api = model.api, let env = model.envID else { return }
        if let fresh = try? await api.card(env: env, card: card.id) {
            card = fresh
            board.replace(fresh)
        }
    }
}
