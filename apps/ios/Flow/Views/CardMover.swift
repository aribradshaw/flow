import SwiftUI

// Moving a card, with the board's checks (docs/api.md "Board gates"): into Done asks first (from UAT it is
// an approval), out of Done asks first, into Doing without a developer asks first.
@MainActor
@Observable
final class CardMover {
    struct Gate: Identifiable {
        let id = UUID()
        let api: FlowAPI
        let env: String
        let card: FlowCard
        let to: BoardColumn
        let error: FlowError

        // From UAT, Done is an approval (the web's Approve button); every other gate is a confirm.
        var approves: Bool { error.code == "confirm_done" && card.column == BoardColumn.uat.rawValue }
        var title: String { "Move \(card.numberText) to \(to.title)?" }
        var action: String {
            switch error.code {
            case "confirm_done": approves ? "Approve" : "Move to Done"
            case "confirm_reopen": "Reopen"
            case "pick_developer": "Move without a developer"
            default: "Move"
            }
        }
    }

    var gate: Gate?
    var error: String?
    var onMoved: ((FlowCard) -> Void)?

    func move(_ api: FlowAPI, env: String, card: FlowCard, to: BoardColumn, confirm: Bool = false, approve: Bool = false) async {
        gate = nil
        var body = FlowAPI.Move(column: to.rawValue, ifUpdated: card.updated)
        if confirm { body.confirm = true }
        if approve { body.approve = true }
        do {
            let moved = try await api.move(env: env, card: card.id, body)
            error = nil
            onMoved?(moved)
        } catch let e as FlowError where e.isGate {
            gate = Gate(api: api, env: env, card: card, to: to, error: e)
        } catch {
            self.error = (error as? FlowError)?.code == "card_changed" ? "This card changed somewhere else. Pull to refresh and try again." : error.localizedDescription
        }
    }

    func go(_ g: Gate) async {
        await move(g.api, env: g.env, card: g.card, to: g.to, confirm: !g.approves, approve: g.approves)
    }
}

extension View {
    func cardMoveDialog(_ mover: CardMover) -> some View {
        confirmationDialog(mover.gate?.title ?? "", isPresented: Binding(get: { mover.gate != nil }, set: { if !$0 { mover.gate = nil } }),
                           titleVisibility: .visible, presenting: mover.gate) { g in
            Button(g.action) { Task { await mover.go(g) } }
            Button("Cancel", role: .cancel) { mover.gate = nil }
        } message: { g in
            Text(g.error.message)
        }
    }
}

// "Move to" for a card's context menu and toolbar.
struct MoveMenu: View {
    let card: FlowCard
    let onMove: (BoardColumn) -> Void

    var body: some View {
        Menu {
            ForEach(BoardColumn.allCases.filter { $0.rawValue != card.column }) { col in
                Button(col.title, systemImage: col.systemImage) { onMove(col) }
            }
        } label: {
            Label("Move to", systemImage: "arrow.right.square")
        }
    }
}
