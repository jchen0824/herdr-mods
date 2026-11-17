import { View, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { run, theme, spaces, panes } from "herdr";

// Buttons at the right of the top bar: Review (Redline) and Kubernetes (the kube mod).
const stop = (_e, cx) => cx.stop_propagation(); // a press here doesn't drag the window

// Kubernetes: go to this space's Kubernetes tab, or open one.
function openKube() {
  const space = spaces().find((s) => s.active);
  const tabs = new Set((space?.tabs ?? []).map((t) => t.id));
  const pane = panes().find((p) => p.mod === "kube" && tabs.has(p.tab));
  if (pane) run("tab.select", { id: pane.tab });
  else run("tab.new", { name: "Kubernetes", mod: "kube" });
}

export default class TopbarActions extends View {
  render() {
    const t = theme();
    const button = (id, icon, label, fn) => h_flex().id(id).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
      .text_size(12).bg(t.chrome).text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop)
      .on_click(() => fn())
      .child(svg(`mods/topbar-actions/${icon}.svg`).size(14))
      .child(label);
    return h_flex().size_full().items_center().justify_end().gap(3).pr(10).bg(t.chrome).border_b(1).border_color(t.border)
      .child(button("topbar-review", "review", "Review", () => run("mod.open", { name: "redline" })))
      .child(button("topbar-kube", "kube", "Kubernetes", openKube));
  }
}
