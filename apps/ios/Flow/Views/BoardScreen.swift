import SwiftUI

struct BoardScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.scenePhase) private var scenePhase
    @State private var board = BoardStore()
    @State private var column: BoardColumn = .doing
    @State private var error: String?
    @State private var gate: Gate?

    struct Gate: Identifiable {
        let id = UUID()
        let card: FlowCard
        let to: BoardColumn
        let error: FlowError
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(model.env?.name ?? "Board")
                .navigationDestination(for: FlowCard.self) { card in
                    CardDetailView(board: board, card: card) { card, to in requestMove(card, to) }
                }
                .toolbar { toolbar }
                .refreshable { await load() }
                .task(id: model.envID) { await load() }
                .onChange(of: board.projectFilter) { Task { await load() } }
                .onChange(of: scenePhase) { if scenePhase == .active { Task { await load() } } }
                .overlay {
                    if board.cards.isEmpty && board.loading { ProgressView() }
                }
                .safeAreaInset(edge: .bottom) {
                    if let error {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .padding(10)
                            .frame(maxWidth: .infinity)
                            .background(.red.opacity(0.15), in: .rect(cornerRadius: 10))
                            .padding(.horizontal)
                            .onTapGesture { self.error = nil }
                    }
                }
                .confirmationDialog(gateTitle, isPresented: Binding(get: { gate != nil }, set: { if !$0 { gate = nil } }), titleVisibility: .visible, presenting: gate) { g in
                    Button(gateAction(g)) {
                        // From UAT, Done is an approval (the web's Approve button); every other gate is a confirm.
                        let approve = g.error.code == "confirm_done" && g.card.column == BoardColumn.uat.rawValue
                        Task { await move(g.card, g.to, confirm: !approve, approve: approve) }
                    }
                    Button("Cancel", role: .cancel) { gate = nil }
                } message: { g in
                    Text(g.error.message)
                }
        }
    }

    @ViewBuilder
    private var content: some View {
        if model.envsLoaded && model.envs.isEmpty {
            ContentUnavailableView {
                Label("No workspace yet", systemImage: "square.stack.3d.up")
            } description: {
                Text("A workspace holds your mind map, timeline and board.")
            } actions: {
                Button("Create a workspace") {
                    Task {
                        do { try await model.createEnvironment(named: "My workspace") } catch { self.error = error.localizedDescription }
                    }
                }
                .buttonStyle(.borderedProminent)
            }
        } else if sizeClass == .regular {
            ScrollView(.horizontal) {
                LazyHStack(alignment: .top, spacing: 16) {
                    ForEach(BoardColumn.allCases) { col in
                        ColumnView(board: board, column: col, onMove: requestMove)
                            .frame(width: 300)
                    }
                }
                .padding()
            }
        } else {
            VStack(spacing: 0) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(BoardColumn.allCases) { col in
                            Button {
                                column = col
                            } label: {
                                Text("\(col.title) \(board.cards(in: col).count)")
                                    .font(.subheadline.weight(.medium))
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 6)
                                    .background(col == column ? AnyShapeStyle(.tint) : AnyShapeStyle(.fill.tertiary), in: .capsule)
                                    .foregroundStyle(col == column ? AnyShapeStyle(.white) : AnyShapeStyle(.primary))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal)
                    .padding(.vertical, 8)
                }
                List {
                    ForEach(board.cards(in: column)) { card in
                        NavigationLink(value: card) {
                            CardRow(board: board, card: card)
                        }
                        .contextMenu { moveMenu(card) }
                    }
                }
                .listStyle(.plain)
                .overlay {
                    if board.cards(in: column).isEmpty && !board.loading {
                        ContentUnavailableView("No cards in \(column.title)", systemImage: column.systemImage)
                    }
                }
            }
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Menu {
                Picker("Environment", selection: Binding(get: { model.envID }, set: { model.envID = $0 })) {
                    ForEach(model.envs) { env in
                        Text(env.name).tag(Optional(env.id))
                    }
                }
            } label: {
                Label("Environment", systemImage: "square.stack.3d.up")
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Picker("Project", selection: $board.projectFilter) {
                    Text("All projects").tag(String?.none)
                    ForEach(board.sortedProjects) { p in
                        Text(p.name).tag(Optional(p.id))
                    }
                }
            } label: {
                Label("Project", systemImage: board.projectFilter == nil ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
            }
        }
    }

    private func moveMenu(_ card: FlowCard) -> some View {
        Menu("Move to") {
            ForEach(BoardColumn.allCases.filter { $0.rawValue != card.column }) { col in
                Button(col.title, systemImage: col.systemImage) { requestMove(card, col) }
            }
        }
    }

    private var gateTitle: String { gate.map { "Move \($0.card.numberText) to \($0.to.title)?" } ?? "" }

    private func gateAction(_ g: Gate) -> String {
        switch g.error.code {
        case "confirm_done": g.card.column == BoardColumn.uat.rawValue ? "Approve" : "Move to Done"
        case "confirm_reopen": "Reopen"
        case "pick_developer": "Move without a developer"
        default: "Move"
        }
    }

    private func requestMove(_ card: FlowCard, _ to: BoardColumn) {
        Task { await move(card, to) }
    }

    private func move(_ card: FlowCard, _ to: BoardColumn, confirm: Bool = false, approve: Bool = false) async {
        gate = nil
        guard let api = model.api, let env = model.envID else { return }
        do {
            try await board.move(api, env: env, card: card, to: to, confirm: confirm, approve: approve)
            error = nil
        } catch let e as FlowError where e.isGate {
            gate = Gate(card: card, to: to, error: e)
        } catch {
            model.handle(error)
            self.error = error.localizedDescription
            if (error as? FlowError)?.code == "card_changed" { await load() }
        }
    }

    private func load() async {
        guard let api = model.api else { return }
        do {
            if model.envs.isEmpty || model.env == nil { try await model.loadEnvs() }
            guard let env = model.envID else { return }
            try await board.load(api, env: env)
            error = nil
        } catch is CancellationError {
        } catch let e as URLError where e.code == .cancelled {
        } catch {
            model.handle(error)
            self.error = error.localizedDescription
        }
    }
}

private struct ColumnView: View {
    let board: BoardStore
    let column: BoardColumn
    let onMove: (FlowCard, BoardColumn) -> Void

    var body: some View {
        let cards = board.cards(in: column)
        VStack(alignment: .leading, spacing: 8) {
            Label("\(column.title) · \(cards.count)", systemImage: column.systemImage)
                .font(.headline)
                .padding(.horizontal, 4)
            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(cards) { card in
                        NavigationLink(value: card) {
                            CardRow(board: board, card: card)
                                .padding(10)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(.background, in: .rect(cornerRadius: 10))
                                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.separator))
                        }
                        .buttonStyle(.plain)
                        .contextMenu {
                            Menu("Move to") {
                                ForEach(BoardColumn.allCases.filter { $0.rawValue != card.column }) { col in
                                    Button(col.title, systemImage: col.systemImage) { onMove(card, col) }
                                }
                            }
                        }
                        .draggable(card.id)
                    }
                }
            }
        }
        .padding(8)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(.fill.quaternary, in: .rect(cornerRadius: 14))
        .dropDestination(for: String.self) { ids, _ in
            guard let id = ids.first, let card = board.cards.first(where: { $0.id == id }), card.column != column.rawValue else { return false }
            onMove(card, column)
            return true
        }
    }
}

struct CardRow: View {
    let board: BoardStore
    let card: FlowCard

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(card.numberText)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                Text(card.title)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(3)
            }
            HStack(spacing: 6) {
                if let id = card.project, let p = board.projects[id] {
                    HStack(spacing: 4) {
                        Circle().fill(Color(flow: p.color)).frame(width: 8, height: 8)
                        Text(p.name).lineLimit(1)
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                ForEach((card.labels ?? []).compactMap { board.labels[$0] }) { label in
                    LabelChip(label: label)
                }
                if let due = card.due, !due.isEmpty {
                    Meta(text: due, systemImage: "calendar")
                }
                if let items = card.checklist, !items.isEmpty {
                    Meta(text: "\(items.filter(\.done).count)/\(items.count)", systemImage: "checklist")
                }
            }
        }
    }
}

// A small icon + text pair (tighter than Label inside a row).
private struct Meta: View {
    let text: String
    let systemImage: String

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: systemImage).imageScale(.small)
            Text(text)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }
}
