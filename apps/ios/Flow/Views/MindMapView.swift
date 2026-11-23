import SwiftUI
import UIKit

// The mind map, drawn natively the way the web app draws it (public/style.css .node, .edge, #canvas):
// white cards with a type icon, yellow notes, dashed project areas, ownership lines with their % and
// dotted grouping lines, on the dot grid. A transparent UIScrollView supplies the gestures (pan with
// momentum, pinch, double tap) and a Canvas redraws at the current zoom, so text stays sharp.

@MainActor
@Observable
final class MapStore {
    private(set) var charts: [ChartInfo] = []
    private(set) var nodes: [FlowNode] = []
    private(set) var edges: [FlowEdge] = []
    private(set) var loading = false
    private(set) var loadedKey: String?
    var chartID: String?

    var chart: ChartInfo? { charts.first { $0.id == chartID } }

    func load(_ api: FlowAPI, env: String) async throws {
        loading = true
        defer { loading = false }
        if loadedKey?.hasPrefix(env + "/") != true {
            charts = try await api.charts(env: env)
            if chartID == nil || !charts.contains(where: { $0.id == chartID }) {
                chartID = (charts.first { $0.active == true } ?? charts.first)?.id
            }
        }
        guard let chartID else { nodes = []; edges = []; return }
        async let n = api.nodes(env: env, chart: chartID)
        async let e = api.edges(env: env, chart: chartID)
        (nodes, edges) = try await (n, e)
        loadedKey = env + "/" + chartID
    }

    func reset() { charts = []; nodes = []; edges = []; loadedKey = nil; chartID = nil }
}

// Where the world is on screen: offset (in zoomed points) and zoom.
@MainActor
@Observable
final class MapCamera {
    var offset: CGPoint = .zero
    var zoom: CGFloat = 1
    var fitRequest = 0
}

struct MindMapView: View {
    let nodes: [FlowNode]
    let edges: [FlowEdge]
    @Binding var selected: String?
    let camera: MapCamera

    private var bounds: CGRect {
        let r = nodes.map(\.rect).reduce(CGRect.null) { $0.union($1) }
        return r.isNull ? CGRect(x: 0, y: 0, width: 400, height: 300) : r.insetBy(dx: -80, dy: -80)
    }

    var body: some View {
        let b = bounds
        ZStack {
            ChartCanvas(nodes: nodes, edges: edges, selected: selected, origin: b.origin, camera: camera)
            ZoomScroller(contentSize: b.size, camera: camera) { p in
                let world = CGPoint(x: p.x + b.minX, y: p.y + b.minY)
                withAnimation(.snappy(duration: 0.2)) { selected = hit(world)?.id }
            }
        }
        .background(Theme.bg)
        .sensoryFeedback(.selection, trigger: selected)
    }

    // Cards first (topmost last drawn), then an area by its title strip or its box.
    private func hit(_ p: CGPoint) -> FlowNode? {
        let pad: CGFloat = 6 / max(camera.zoom, 0.3)
        if let n = nodes.last(where: { $0.type != "area" && $0.rect.insetBy(dx: -pad, dy: -pad).contains(p) }) { return n }
        return nodes.last(where: { $0.type == "area" && $0.rect.contains(p) })
    }
}

private struct ChartCanvas: View {
    let nodes: [FlowNode]
    let edges: [FlowEdge]
    let selected: String?
    let origin: CGPoint
    let camera: MapCamera

    var body: some View {
        // Read here (not inside the renderer) so every scroll and zoom redraws the canvas.
        let z = camera.zoom, off = camera.offset
        Canvas { ctx, size in
            let toScreen = { (p: CGPoint) in
                CGPoint(x: (p.x - origin.x) * z - off.x, y: (p.y - origin.y) * z - off.y)
            }
            let rect = { (r: CGRect) in CGRect(origin: toScreen(r.origin), size: CGSize(width: r.width * z, height: r.height * z)) }
            let visible = CGRect(origin: .zero, size: size).insetBy(dx: -40, dy: -40)

            // Dot grid (16 world points apart, coarser when zoomed out, like the web).
            let step = 16 * z * (z < 0.45 ? 4 : z < 0.8 ? 2 : 1)
            let o = toScreen(.zero)
            var dots = Path()
            var y = o.y.truncatingRemainder(dividingBy: step); if y < 0 { y += step }
            while y < size.height {
                var x = o.x.truncatingRemainder(dividingBy: step); if x < 0 { x += step }
                while x < size.width { dots.addEllipse(in: CGRect(x: x - 0.9, y: y - 0.9, width: 1.8, height: 1.8)); x += step }
                y += step
            }
            ctx.fill(dots, with: .color(Theme.dots))

            let byID = Dictionary(nodes.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })

            // Areas behind everything.
            for n in nodes where n.type == "area" {
                let r = rect(n.rect)
                guard r.intersects(visible) else { continue }
                let shape = Path(roundedRect: r, cornerRadius: 3 * z)
                ctx.fill(shape, with: .color(Theme.surface.opacity(0.45)))
                ctx.stroke(shape, with: .color(n.id == selected ? Theme.green : Theme.faint), style: StrokeStyle(lineWidth: n.id == selected ? 2 : 1, dash: [4, 3]))
                if z > 0.3 {
                    ctx.draw(Text(Image(systemName: "square.dashed")).font(.system(size: 11 * z)).foregroundStyle(Theme.faint),
                             at: CGPoint(x: r.minX + 14 * z, y: r.minY + 16 * z))
                    ctx.draw(Text(n.name).font(.system(size: 12.5 * z, weight: .medium)).foregroundStyle(Theme.muted),
                             in: CGRect(x: r.minX + 26 * z, y: r.minY + 8 * z, width: r.width - 34 * z, height: 18 * z))
                }
            }

            // Lines: elbows from the parent's bottom to the child's top (or side to side), rounded corners.
            for e in edges {
                guard let a = byID[e.from], let b = byID[e.to] else { continue }
                let (path, label) = elbow(rect(a.rect), rect(b.rect), radius: 8 * z)
                guard path.boundingRect.intersects(visible) else { continue }
                if e.isGroup {
                    ctx.stroke(path, with: .color(Theme.edgeGroup), style: StrokeStyle(lineWidth: max(1, 1.8 * z), lineCap: .round, dash: [0, 4.5 * z]))
                } else {
                    ctx.stroke(path, with: .color(Theme.edge), style: StrokeStyle(lineWidth: max(1, 1.5 * z), lineJoin: .round))
                    if let pct = e.percent, !pct.isEmpty, z > 0.2 {
                        let text = Text("\(pct)%").font(.system(size: 10.5 * z, weight: .semibold)).foregroundStyle(Theme.ink)
                        let w = CGFloat(pct.count + 1) * 6.2 * z + 10 * z, h = 16 * z
                        let box = CGRect(x: label.x - w / 2, y: label.y - h / 2, width: w, height: h)
                        ctx.fill(Path(roundedRect: box, cornerRadius: 3 * z), with: .color(Theme.surface))
                        ctx.stroke(Path(roundedRect: box, cornerRadius: 3 * z), with: .color(Theme.line2), lineWidth: 1)
                        ctx.draw(text, at: label)
                    }
                }
            }

            // Cards.
            for n in nodes where n.type != "area" {
                let r = rect(n.rect)
                guard r.intersects(visible) else { continue }
                let shape = Path(roundedRect: r, cornerRadius: 3 * z)
                let isNote = n.type == "note", sel = n.id == selected
                var shadow = ctx
                shadow.addFilter(.shadow(color: .black.opacity(0.06), radius: 1.5 * z, y: 1 * z))
                shadow.fill(shape, with: .color(isNote ? Theme.dyn(0xfffbea, 0x332f1f) : Theme.surface))
                ctx.stroke(shape, with: .color(sel ? Theme.green : isNote ? Theme.dyn(0xe9dcae, 0x5a5130) : Theme.line2), lineWidth: sel ? 2 : 1)
                if sel {
                    ctx.stroke(Path(roundedRect: r.insetBy(dx: -3, dy: -3), cornerRadius: 5 * z), with: .color(Theme.green.opacity(0.35)), lineWidth: 3)
                }
                guard z > 0.22 else { continue }
                let iconColor: Color = n.type == "person" ? Theme.person : isNote ? Theme.note : Theme.accent
                let iy = isNote ? r.minY + 17 * z : r.midY
                ctx.draw(Text(Image(systemName: n.symbol)).font(.system(size: 12 * z, weight: .medium)).foregroundStyle(iconColor),
                         at: CGPoint(x: r.minX + 17 * z, y: iy))
                let textRect = CGRect(x: r.minX + 31 * z, y: r.minY + 6 * z, width: r.width - 39 * z, height: r.height - 12 * z)
                var resolved = ctx.resolve(Text(n.name).font(.system(size: 12.5 * z, weight: .medium)).foregroundStyle(Theme.ink))
                resolved.shading = .color(Theme.ink)
                let measured = resolved.measure(in: textRect.size)
                let y = isNote ? textRect.minY + 4 * z : textRect.midY - measured.height / 2
                ctx.draw(resolved, in: CGRect(x: textRect.minX, y: y, width: textRect.width, height: min(measured.height, textRect.height)))
            }
        }
        .allowsHitTesting(false)
    }

    // An org-chart elbow between two screen rects, and where its % label sits.
    private func elbow(_ a: CGRect, _ b: CGRect, radius: CGFloat) -> (Path, CGPoint) {
        var p = Path()
        let vertical = b.minY >= a.maxY + 8 || a.minY >= b.maxY + 8
        if vertical {
            let down = b.minY >= a.maxY
            let s = CGPoint(x: a.midX, y: down ? a.maxY : a.minY), t = CGPoint(x: b.midX, y: down ? b.minY : b.maxY)
            let midY = (s.y + t.y) / 2
            p.move(to: s)
            if abs(s.x - t.x) < 1 {
                p.addLine(to: t)
            } else {
                let r = min(radius, abs(t.x - s.x) / 2, abs(midY - s.y))
                let dx: CGFloat = t.x > s.x ? 1 : -1, dy: CGFloat = down ? 1 : -1
                p.addLine(to: CGPoint(x: s.x, y: midY - dy * r))
                p.addQuadCurve(to: CGPoint(x: s.x + dx * r, y: midY), control: CGPoint(x: s.x, y: midY))
                p.addLine(to: CGPoint(x: t.x - dx * r, y: midY))
                p.addQuadCurve(to: CGPoint(x: t.x, y: midY + dy * r), control: CGPoint(x: t.x, y: midY))
                p.addLine(to: t)
            }
            arrow(&p, at: t, pointing: CGVector(dx: 0, dy: down ? 1 : -1), size: radius * 0.75)
            return (p, CGPoint(x: t.x, y: (midY + t.y) / 2))
        }
        let right = b.minX >= a.maxX
        let s = CGPoint(x: right ? a.maxX : a.minX, y: a.midY), t = CGPoint(x: right ? b.minX : b.maxX, y: b.midY)
        let midX = (s.x + t.x) / 2
        p.move(to: s)
        p.addLine(to: CGPoint(x: midX, y: s.y))
        p.addLine(to: CGPoint(x: midX, y: t.y))
        p.addLine(to: t)
        arrow(&p, at: t, pointing: CGVector(dx: right ? 1 : -1, dy: 0), size: radius * 0.75)
        return (p, CGPoint(x: (midX + t.x) / 2, y: t.y))
    }

    private func arrow(_ p: inout Path, at t: CGPoint, pointing v: CGVector, size: CGFloat) {
        let back = CGPoint(x: t.x - v.dx * size, y: t.y - v.dy * size)
        let side = CGVector(dx: -v.dy * size * 0.45, dy: v.dx * size * 0.45)
        p.move(to: CGPoint(x: back.x + side.dx, y: back.y + side.dy))
        p.addLine(to: t)
        p.addLine(to: CGPoint(x: back.x - side.dx, y: back.y - side.dy))
    }
}

// Gestures only: a clear UIScrollView over the Canvas reports offset and zoom into the camera.
private struct ZoomScroller: UIViewRepresentable {
    let contentSize: CGSize
    let camera: MapCamera
    let onTap: (CGPoint) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> UIScrollView {
        let sv = UIScrollView()
        sv.backgroundColor = .clear
        sv.delegate = context.coordinator
        sv.showsHorizontalScrollIndicator = false
        sv.showsVerticalScrollIndicator = false
        sv.bouncesZoom = true
        sv.decelerationRate = .normal
        sv.contentInsetAdjustmentBehavior = .never
        let content = UIView(frame: CGRect(origin: .zero, size: contentSize))
        content.backgroundColor = .clear
        sv.addSubview(content)
        context.coordinator.content = content
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tapped(_:)))
        let double = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.doubleTapped(_:)))
        double.numberOfTapsRequired = 2
        tap.require(toFail: double)
        sv.addGestureRecognizer(tap)
        sv.addGestureRecognizer(double)
        return sv
    }

    func updateUIView(_ sv: UIScrollView, context: Context) {
        let c = context.coordinator
        c.parent = self
        if c.content?.bounds.size != contentSize || c.fitted != camera.fitRequest || c.needsFit {
            c.fitted = camera.fitRequest
            DispatchQueue.main.async { c.fit(sv) }
        }
    }

    @MainActor
    final class Coordinator: NSObject, UIScrollViewDelegate {
        var parent: ZoomScroller
        weak var content: UIView?
        var fitted = -1
        var needsFit = true

        init(_ p: ZoomScroller) { parent = p }

        func viewForZooming(in scrollView: UIScrollView) -> UIView? { content }

        func scrollViewDidScroll(_ sv: UIScrollView) { publish(sv) }
        func scrollViewDidZoom(_ sv: UIScrollView) { center(sv); publish(sv) }

        func publish(_ sv: UIScrollView) {
            parent.camera.zoom = sv.zoomScale
            parent.camera.offset = sv.contentOffset
        }

        // Keeps a map smaller than the screen in the middle.
        func center(_ sv: UIScrollView) {
            let w = sv.contentSize.width, h = sv.contentSize.height
            let ix = max(0, (sv.bounds.width - w) / 2), iy = max(0, (sv.bounds.height - h) / 2)
            sv.contentInset = UIEdgeInsets(top: iy, left: ix, bottom: iy, right: ix)
        }

        // The whole chart on screen (not larger than 1:1), centered.
        func fit(_ sv: UIScrollView) {
            guard let content, sv.bounds.width > 0 else { needsFit = true; return }
            needsFit = false
            let size = parent.contentSize
            sv.zoomScale = 1
            content.frame = CGRect(origin: .zero, size: size)
            sv.contentSize = size
            let fit = min(sv.bounds.width / size.width, sv.bounds.height / size.height)
            sv.minimumZoomScale = max(0.08, min(fit, 1) * 0.6)
            sv.maximumZoomScale = 3
            sv.setZoomScale(min(fit, 1), animated: false)
            center(sv)
            let ox = max(-sv.contentInset.left, (sv.contentSize.width - sv.bounds.width) / 2)
            sv.setContentOffset(CGPoint(x: ox, y: -sv.contentInset.top), animated: false)
            publish(sv)
        }

        @objc func tapped(_ g: UITapGestureRecognizer) {
            guard let content else { return }
            parent.onTap(g.location(in: content))
        }

        @objc func doubleTapped(_ g: UITapGestureRecognizer) {
            guard let sv = g.view as? UIScrollView, let content else { return }
            let p = g.location(in: content)
            if sv.zoomScale < min(1.4, sv.maximumZoomScale) * 0.9 {
                let z = min(sv.zoomScale * 2.2, sv.maximumZoomScale)
                let w = sv.bounds.width / z, h = sv.bounds.height / z
                sv.zoom(to: CGRect(x: p.x - w / 2, y: p.y - h / 2, width: w, height: h), animated: true)
            } else {
                sv.setZoomScale(sv.minimumZoomScale / 0.6, animated: true)
            }
        }
    }
}

// A tapped card: what it is, its notes, and its lines.
struct NodeSheet: View {
    let node: FlowNode
    let nodes: [FlowNode]
    let edges: [FlowEdge]
    let onSelect: (String) -> Void

    var body: some View {
        let byID = Dictionary(nodes.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let owners = edges.filter { $0.to == node.id }.compactMap { e in byID[e.from].map { (e, $0) } }
        let owns = edges.filter { $0.from == node.id }.compactMap { e in byID[e.to].map { (e, $0) } }
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(spacing: 10) {
                        if node.type == "person" {
                            Avatar(name: node.name, image: node.image, size: 40)
                        } else {
                            Image(systemName: node.symbol)
                                .font(.system(size: 17, weight: .medium))
                                .foregroundStyle(node.type == "note" ? Theme.note : Theme.accent)
                                .frame(width: 40, height: 40)
                                .background(Theme.accentWash, in: .rect(cornerRadius: Theme.corner))
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(node.name).font(.title3.weight(.semibold)).foregroundStyle(Theme.ink)
                            Text(node.kindTitle).font(.subheadline).foregroundStyle(Theme.muted)
                        }
                    }
                    if let notes = node.notes, !notes.isEmpty {
                        Text(notes).font(.callout).foregroundStyle(Theme.ink).textSelection(.enabled).cardSurface()
                    }
                    if !owners.isEmpty { relations(node.type == "area" ? "In" : "Owned by", owners, onSelect) }
                    if !owns.isEmpty { relations("Owns or groups", owns, onSelect) }
                }
                .padding()
            }
            .background(Theme.bg)
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func relations(_ title: String, _ list: [(FlowEdge, FlowNode)], _ onSelect: @escaping (String) -> Void) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).flowSectionTitle()
            VStack(spacing: 0) {
                ForEach(Array(list.enumerated()), id: \.offset) { i, pair in
                    let (e, n) = pair
                    Button { onSelect(n.id) } label: {
                        HStack(spacing: 10) {
                            Image(systemName: n.symbol).foregroundStyle(n.type == "person" ? Theme.person : Theme.accent).frame(width: 20)
                            Text(n.name).foregroundStyle(Theme.ink).lineLimit(1)
                            Spacer()
                            if e.isGroup { Tag(text: "Group", color: Theme.muted) }
                            else if let p = e.percent, !p.isEmpty { Tag(text: "\(p)%", color: Theme.accent) }
                            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.faint)
                        }
                        .padding(.vertical, 10)
                        .padding(.horizontal, 12)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    if i < list.count - 1 { Divider().overlay(Theme.line).padding(.leading, 42) }
                }
            }
            .background(Theme.surface, in: .rect(cornerRadius: Theme.corner))
            .overlay(RoundedRectangle(cornerRadius: Theme.corner).strokeBorder(Theme.line))
        }
    }
}
