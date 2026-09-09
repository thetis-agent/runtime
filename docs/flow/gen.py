#!/usr/bin/env python3
"""Render the three turn sequence diagrams as theme-aware inline SVG.

Run: python3 gen.py  (writes base.svg, skills.svg, tools.svg beside it)
Strokes and text use currentColor so the page's theme applies; the one
accent hue marks contract names.
"""
import html, pathlib, re

COL = 168          # column pitch
TOP = 74           # header height
FONT = 12
ACCENT = "#0E6C78"
MUTED_OP = ".72"

def esc(s): return html.escape(s, quote=True)

class Diagram:
    def __init__(self, title, participants):
        self.title = title
        self.p = [pid for pid, _ in participants]
        self.labels = {pid: lab for pid, lab in participants}
        self.steps = []
        self.n = 0
    # step builders
    def msg(self, a, b, text, dashed=False, contract=None):
        self.steps.append(("msg", a, b, text, dashed, contract))
    def note(self, over, lines):
        self.steps.append(("note", over, lines))
    def frame(self, kind, label, inner, else_label=None, else_inner=None):
        self.steps.append(("frame", kind, label, inner, else_label, else_inner))
    def x(self, pid): return 60 + self.p.index(pid) * COL

    # rendering
    def render(self):
        out = []
        y = [TOP + 10]
        W = 60 + (len(self.p) - 1) * COL + 60
        def text(x, yy, s, size=FONT, anchor="middle", op=None, mono=False, fill=None, weight=None):
            style = f'font-size="{size}"'
            if mono: style += ' font-family="IBM Plex Mono, Menlo, monospace"'
            if op: style += f' opacity="{op}"'
            if fill: style += f' fill="{fill}"'
            if weight: style += f' font-weight="{weight}"'
            out.append(f'<text x="{x}" y="{yy}" text-anchor="{anchor}" {style}>{esc(s)}</text>')
        def step_list(steps, depth):
            for st in steps:
                kind = st[0]
                if kind == "msg":
                    _, a, b, t, dashed, contract = st
                    lines = t.split("\n")
                    xa, xb = self.x(a), self.x(b)
                    h = 14 * len(lines) + (12 if contract else 0)
                    yy = y[0] + h
                    if a == b:
                        # self message: small loop
                        out.append(f'<path d="M{xa} {yy-h+6} H{xa+40} V{yy+8} H{xa+6}" fill="none" stroke="currentColor" stroke-width="1.2" marker-end="url(#ar)"/>')
                        for i, ln in enumerate(lines):
                            text(xa + 48, yy - h + 10 + i * 14, ln, anchor="start")
                        if contract: text(xa + 48, yy - h + 10 + len(lines) * 14, contract, size=10.5, anchor="start", mono=True, fill=ACCENT)
                        y[0] = yy + 18
                    else:
                        self.n += 1
                        mid = (xa + xb) / 2
                        for i, ln in enumerate(lines):
                            text(mid, yy - h + 10 + i * 14, ln)
                        if contract: text(mid, yy - h + 10 + len(lines) * 14, contract, size=10.5, mono=True, fill=ACCENT)
                        dash = ' stroke-dasharray="5 4"' if dashed else ''
                        ay = yy + 6
                        out.append(f'<line x1="{xa}" y1="{ay}" x2="{xb}" y2="{ay}" stroke="currentColor" stroke-width="1.2"{dash} marker-end="url(#ar)"/>')
                        # number badge at the origin
                        bx = xa + (12 if xb > xa else -12)
                        out.append(f'<circle cx="{bx}" cy="{ay}" r="8" fill="{ACCENT}"/>')
                        out.append(f'<text x="{bx}" y="{ay+3.5}" text-anchor="middle" font-size="9" fill="#fff" font-weight="600">{self.n}</text>')
                        y[0] = ay + 14
                elif kind == "note":
                    _, over, lines = st
                    xs = [self.x(p) for p in over]
                    need = max(len(ln) for ln in lines) * 5.9 + 24
                    cx = (min(xs) + max(xs)) / 2
                    half = max((max(xs) - min(xs)) / 2 + 60, need / 2)
                    x0, x1 = cx - half, cx + half
                    h = 14 * len(lines) + 12
                    out.append(f'<rect x="{x0}" y="{y[0]}" width="{x1-x0}" height="{h}" fill="{ACCENT}" fill-opacity=".08" stroke="{ACCENT}" stroke-opacity=".5" stroke-width="1"/>')
                    for i, ln in enumerate(lines):
                        text((x0 + x1) / 2, y[0] + 16 + i * 14, ln, size=11)
                    y[0] += h + 10
                elif kind == "frame":
                    _, fk, label, inner, else_label, else_inner = st
                    x0 = 20 + depth * 8
                    x1 = W - 20 - depth * 8
                    y0 = y[0]
                    out.append(f'<g id="frame-{len(out)}">')
                    y[0] += 26
                    step_list(inner, depth + 1)
                    if else_inner is not None:
                        ym = y[0]
                        out.append(f'<line x1="{x0}" y1="{ym}" x2="{x1}" y2="{ym}" stroke="currentColor" stroke-dasharray="4 4" opacity=".6"/>')
                        text(x0 + 10, ym + 15, f"[{else_label}]", size=11, anchor="start", op=MUTED_OP)
                        y[0] += 24
                        step_list(else_inner, depth + 1)
                    y[0] += 6
                    h = y[0] - y0
                    out.append(f'<rect x="{x0}" y="{y0}" width="{x1-x0}" height="{h}" fill="none" stroke="currentColor" stroke-width="1" opacity=".55"/>')
                    tab_w = 8 * len(fk) + 18
                    out.append(f'<path d="M{x0} {y0} H{x0+tab_w} V{y0+18} H{x0+tab_w-8} L{x0+tab_w-12} {y0+22} H{x0} Z" fill="currentColor" fill-opacity=".12" stroke="currentColor" stroke-width="1" opacity=".7"/>')
                    text(x0 + 8, y0 + 15, fk, size=11, anchor="start", weight="600")
                    text(x0 + tab_w + 8, y0 + 15, f"[{label}]", size=11, anchor="start", op=MUTED_OP)
                    out.append('</g>')
                    y[0] += 8
        step_list(self.steps, 0)
        H = y[0] + 20
        # lifelines and headers drawn first
        head = []
        for pid in self.p:
            x = self.x(pid)
            lab = self.labels[pid]
            lines = lab.split("\n")
            bh = 14 * len(lines) + 14
            by = TOP - bh - 6
            head.append(f'<line x1="{x}" y1="{TOP}" x2="{x}" y2="{H-10}" stroke="currentColor" stroke-dasharray="3 5" opacity=".5"/>')
            head.append(f'<rect x="{x-72}" y="{by}" width="144" height="{bh}" rx="3" fill="currentColor" fill-opacity=".06" stroke="currentColor" stroke-width="1"/>')
            for i, ln in enumerate(lines):
                w = "600" if i == 0 else None
                sz = 12 if i == 0 else 10.5
                head.append(f'<text x="{x}" y="{by+16+i*14}" text-anchor="middle" font-size="{sz}"{" font-weight=%r" % w if w else ""}>{esc(ln)}</text>')
        svg = [f'<svg viewBox="0 0 {W} {H}" role="img" aria-label="{esc(self.title)}" style="max-width:100%;height:auto;color:inherit;font-family:IBM Plex Sans, Helvetica, Arial, sans-serif">',
               '<defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>',
               '<g fill="currentColor">']
        svg += head + out + ['</g></svg>']
        return "\n".join(svg)

def base():
    d = Diagram("Base turn: no skills pack, no tool pack", [
        ("person", "Person"),
        ("gw", "Gateway package\nobserve hooks"),
        ("host", "Kernel\nidentity · boundary"),
        ("core", "Core\nthe loop"),
        ("prov", "Provider package\ndeployment scope"),
        ("model", "Model vendor"),
    ])
    d.msg("person", "gw", "message", contract="the gateway's wire protocol")
    d.msg("gw", "host", "session.submit(identity evidence, text)", contract="contract/kernel-socket")
    d.note(["host"], ["resolves the person from its bindings;", "hands the environment the turn"])
    d.msg("host", "core", "input", contract="contract/turn-events")
    d.msg("core", "core", "retrieve (single): no provider → empty", contract="contract/turn-events")
    d.msg("core", "core", "context: system · skills (empty) · harness · history")
    d.note(["core"], ["turn 1: render the prefix once and store it (ADR 0013)"])
    d.msg("core", "core", "offer (answer): no handlers → empty")
    d.note(["host"], ["at run start the boundary mounted the provider socket this run may use:", "the person's instance, else the project's, else the deployment's (ADR 0019)"])
    d.msg("core", "prov", "begin · message* · end (cache policy)", contract="contract/provider · run token on the socket")
    d.msg("prov", "model", "the vendor's request, with the provider's own key")
    d.msg("model", "prov", "the vendor's stream", dashed=True)
    d.msg("prov", "core", "start · delta.text* · usage { counters } · stop", dashed=True, contract="contract/provider")
    d.msg("prov", "host", "usage.report(counters, run token)", contract="contract/kernel-socket · appended uninterpreted")
    d.msg("core", "gw", "token*", dashed=True, contract="contract/turn-events (observe)")
    d.msg("gw", "person", "rendered stream", dashed=True)
    d.msg("core", "gw", "output · end (observe)")
    d.msg("core", "host", "turn.report (candidate-reported rows)", contract="contract/kernel-socket")
    d.msg("gw", "person", "final message", dashed=True)
    return d

def skills():
    d = Diagram("Skills only: the retriever answers on turn 1 and the stored prefix serves later turns", [
        ("person", "Person"),
        ("gw", "Gateway package"),
        ("host", "Kernel\nboundary"),
        ("core", "Core\nthe loop"),
        ("ret", "Retriever package\nsingle: stage/retrieve"),
        ("packs", "Skills packs\ndata: skills/ dirs"),
        ("prov", "Provider package"),
    ])
    d.note(["ret", "packs"], ["at process start: init(profile, ctx) reads every pack's skills/", "and builds the cards — contract/skills"])
    d.msg("person", "gw", "message")
    d.msg("gw", "host", "session.submit", contract="contract/kernel-socket")
    d.msg("host", "core", "input", contract="contract/turn-events")
    d.frame("alt", "turn 1, or a refresh after a profile change", [
        ("msg", "core", "ret", "retrieve { query, k, budget, model }", False, "contract/turn-events"),
        ("msg", "ret", "packs", "read matching SKILL.md bodies at their versions", False, "contract/skills"),
        ("msg", "ret", "core", "{ entries: [ { id, pack, version, contentHash, universal, body } ], dropped }", True, None),
        ("note", ["core"], ["renders entries into the skills section with the fixed wrapping;", "stores the prefix: system · skills · offer (ADR 0013)"]),
    ], "later turns", [
        ("note", ["core"], ["loads the stored prefix; retrieve is not run"]),
    ])
    d.msg("core", "core", "context: system · skills · harness · history\n(append hooks may add to harness)")
    d.msg("core", "core", "offer: empty")
    d.msg("core", "prov", "begin · message* · end (cache policy: prefixThrough)", contract="contract/provider · prefix byte-identical → cache hit")
    d.msg("prov", "core", "delta.text* · usage { counters } · stop", dashed=True)
    d.msg("prov", "host", "usage.report", contract="contract/kernel-socket")
    d.msg("core", "gw", "token* · output · end", dashed=True, contract="observe")
    d.msg("gw", "person", "response", dashed=True)
    return d

def tools():
    d = Diagram("Tools only: offer, model, call repeat inside one turn; the core validates and spills", [
        ("person", "Person"),
        ("gw", "Gateway package"),
        ("host", "Kernel\nboundary · sandbox"),
        ("core", "Core\nthe loop"),
        ("tools", "Tool pack\nanswer: offer · own: call"),
        ("prov", "Provider package"),
    ])
    d.msg("person", "gw", "message")
    d.msg("gw", "host", "session.submit", contract="contract/kernel-socket")
    d.msg("host", "core", "input", contract="contract/turn-events")
    d.msg("core", "core", "retrieve: empty · context: system · harness · history")
    d.frame("loop", "each iteration, until an answer, endsTurn, the limit, or a cancel", [
        ("msg", "core", "tools", "offer { mode: { readOnly, deny } }", False, "contract/turn-events (answer)"),
        ("msg", "tools", "core", "ToolDef[] { name, schema, readOnly, endsTurn, derived? }", True, None),
        ("note", ["core"], ["drops mutating tools in read-only mode;", "derived readOnly is untrusted unless marked;", "turn 1: the schemas join the stored prefix"]),
        ("msg", "core", "prov", "begin · message* · tool* · end", False, "contract/provider"),
        ("msg", "prov", "core", "delta.tool_call fragments · usage { counters } · stop(tool_calls)", True, None),
        ("msg", "prov", "host", "usage.report", False, "contract/kernel-socket"),
        ("note", ["core"], ["assembles fragments by callId; validates args against the offered schema;", "refuses not-offered and invalid-args itself"]),
        ("msg", "core", "tools", "call { id, name, args, mode, roots, budget, deadlineMs }", False, "contract/turn-events (own)"),
        ("note", ["tools"], ["roots = the sandbox's mount list (ADR 0005);", "a path outside them is an error naming what exists"]),
        ("msg", "tools", "core", "{ ok, content[] } · { ok: false, error } · { pending: handle }", True, None),
        ("note", ["core"], ["spills a result over the budget into the person's space through the core's sink;", "appends the tool message to history"]),
    ])
    d.msg("core", "gw", "token* · output · end", dashed=True, contract="observe")
    d.msg("gw", "person", "response", dashed=True)
    d.frame("opt", "a call that outlived its deadline", [
        ("msg", "tools", "core", "notice { handle, content } between turns", True, "emit hook"),
        ("note", ["core"], ["appended to history at the next boundary,", "or starts a turn if the conversation allows waking"]),
    ])
    return d

if __name__ == "__main__":
    here = pathlib.Path(__file__).parent
    for name, fn in [("base", base), ("skills", skills), ("tools", tools)]:
        (here / f"{name}.svg").write_text(fn().render())
        print("wrote", name)
