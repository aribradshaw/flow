import SwiftUI

struct BoardScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.scenePhase) private var scenePhase
    @Binding var path: NavigationPath
    @State private var board = BoardStore()
    @State private var mover = CardMover()
    @State private var column: BoardColumn = .doing
    @State private var error: String?
    @State private var newCardColumn: BoardColumn?

    var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationTitle(model.env?.name ?? "Board")
                .navigationDestination(for: CardRef.self) { ref in
                    CardDetailView(ref: ref, initial: board.cards.first { $0.id == ref.id }) { board.replace($0) }
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
                    if let message = error ?? mover.error {
                        Label(message, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .padding(10)
                            .frame(maxWidth: .infinity)
                            .background(.red.opacity(0.15), in: .rect(cornerRadius: 10))
                            .padding(.horizontal)
                            .onTapGesture { error = nil; mover.error = nil }
                    }
                }
                .cardMoveDialog(mover)
                .sheet(item: $newCardColumn) { col in
                    if let env = model.envID {
                        CardEditorView(mode: .create(env: env, column: col, project: board.projectFilter)) { card in
                            board.replace(card)
                            column = BoardColumn(rawValue: card.column) ?? column
                        }
                    }
                }
                .onAppear { mover.onMoved = { board.replace($0) } }
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
                        ColumnView(board: board, column: col, onMove: requestMove, onAdd: { newCardColumn = col })
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
                        NavigationLink(value: CardRef(env: model.envID ?? "", id: card.id)) {
                            CardRow(board: board, card: card)
                        }
                        .contextMenu { MoveMenu(card: card) { requestMove(card, $0) } }
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
        ToolbarItemGroup(placement: .topBarTrailing) {
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
            Button("New card", systemImage: "plus") {
                newCardColumn = sizeClass == .regular ? .requests : column
            }
            .disabled(model.envID == nil)
        }
    }

    private func requestMove(_ card: FlowCard, _ to: BoardColumn) {
        guard let api = model.api, let env = model.envID else { return }
        Task { await mover.move(api, env: env, card: card, to: to) }
    }

    private func load() async {
        guard let api = model.api else { return }
        do {
            if model.envs.isEmpty || model.env == nil { try await model.loadEnvs() }
            guard let env = model.envID else { return }
            try await board.load(api, env: env)
            model.setMeta(env, projects: Array(board.projects.values), labels: Array(board.labels.values))
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
    @Environment(AppModel.self) private var model
    let board: BoardStore
    let column: BoardColumn
    let onMove: (FlowCard, BoardColumn) -> Void
    let onAdd: () -> Void

    var body: some View {
        let cards = board.cards(in: column)
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("\(column.title) · \(cards.count)", systemImage: column.systemImage)
                    .font(.headline)
                Spacer()
                Button("Add a card to \(column.title)", systemImage: "plus", action: onAdd)
                    .labelStyle(.iconOnly)
            }
            .padding(.horizontal, 4)
            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(cards) { card in
                        NavigationLink(value: CardRef(env: model.envID ?? "", id: card.id)) {
                            CardRow(board: board, card: card)
                                .padding(10)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(.background, in: .rect(cornerRadius: 10))
                                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.separator))
                        }
                        .buttonStyle(.plain)
                        .contextMenu { MoveMenu(card: card) { onMove(card, $0) } }
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
