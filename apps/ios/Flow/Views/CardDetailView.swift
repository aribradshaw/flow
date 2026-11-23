import SwiftUI

// One card, from the board, the inbox, a notification or a widget.
struct CardDetailView: View {
    @Environment(AppModel.self) private var model
    let ref: CardRef
    let onChange: (FlowCard) -> Void
    @State private var card: FlowCard?
    @State private var meta = AppModel.EnvMeta()
    @State private var mover = CardMover()
    @State private var editing = false
    @State private var error: String?

    init(ref: CardRef, initial: FlowCard? = nil, onChange: @escaping (FlowCard) -> Void = { _ in }) {
        self.ref = ref
        self.onChange = onChange
        _card = State(initialValue: initial)
    }

    var body: some View {
        Group {
            if let card {
                details(card)
            } else if let error {
                ContentUnavailableView("Can't open this card", systemImage: "exclamationmark.triangle", description: Text(error))
            } else {
                ProgressView()
            }
        }
        .navigationTitle(card?.numberText ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let card {
                ToolbarItemGroup(placement: .primaryAction) {
                    Button("Edit") { editing = true }
                    MoveMenu(card: card) { to in
                        guard let api = model.api else { return }
                        Task { await mover.move(api, env: ref.env, card: card, to: to) }
                    }
                }
            }
        }
        .sheet(isPresented: $editing) {
            if let card {
                CardEditorView(mode: .edit(env: ref.env, card: card)) { updated($0) }
            }
        }
        .cardMoveDialog(mover)
        .task { mover.onMoved = { updated($0) }; await refresh() }
        .refreshable { await refresh() }
    }

    @ViewBuilder
    private func details(_ card: FlowCard) -> some View {
        let column = BoardColumn(rawValue: card.column)
        List {
            if let message = error ?? mover.error {
                Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(.red).font(.footnote)
            }
            Section {
                Text(card.title)
                    .font(.title3.weight(.semibold))
                    .textSelection(.enabled)
                LabeledContent("Column") {
                    HStack(spacing: 6) {
                        Image(systemName: column?.systemImage ?? "square").imageScale(.small)
                        Text(column?.title ?? card.column)
                    }
                }
                if let id = card.project, let p = meta.projects[id] {
                    LabeledContent("Project") {
                        HStack(spacing: 6) {
                            Circle().fill(Color(flow: p.color)).frame(width: 9, height: 9)
                            Text(p.name)
                        }
                    }
                }
                let labels = (card.labels ?? []).compactMap { meta.labels[$0] }
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
                    Text(text).textSelection(.enabled)
                }
            }

            if let items = card.checklist, !items.isEmpty {
                Section("Checklist · \(items.filter(\.done).count)/\(items.count)") {
                    ForEach(items) { item in
                        Button {
                            Task { await toggle(item) }
                        } label: {
                            Label(item.text, systemImage: item.done ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(item.done ? .secondary : .primary)
                        }
                        .buttonStyle(.plain)
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
    }

    private func updated(_ fresh: FlowCard) {
        card = fresh
        error = nil
        onChange(fresh)
    }

    private func refresh() async {
        guard let api = model.api else { return }
        meta = await model.meta(ref.env)
        do {
            updated(try await api.card(env: ref.env, card: ref.id))
        } catch {
            model.handle(error)
            if card == nil || (error as? FlowError)?.status == 404 { self.error = error.localizedDescription }
        }
    }

    // Ticks one item: the whole list is sent, with ifUpdated so a change made elsewhere is not lost.
    private func toggle(_ item: FlowCard.ChecklistItem) async {
        guard let api = model.api, let card else { return }
        let list = (card.checklist ?? []).map { CardPatch.ChecklistEdit(id: $0.id, text: $0.text, done: $0.id == item.id ? !$0.done : $0.done) }
        do {
            updated(try await api.updateCard(env: ref.env, card: card.id, CardPatch(checklist: list, ifUpdated: card.updated)))
        } catch let e as FlowError where e.code == "card_changed" {
            error = "This card changed somewhere else, so it was reloaded. Try again."
            await refresh()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
