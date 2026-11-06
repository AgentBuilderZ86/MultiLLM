// Rendu Markdown minimal et sûr : tout le HTML est échappé avant transformation.
(function () {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function inline(text) {
    const codes = [];
    let s = text.replace(/`([^`\n]+)`/g, (_, c) => {
      codes.push(`<code>${c}</code>`);
      return `\u0000${codes.length - 1}\u0000`;
    });
    s = s
      .replace(/!\[([^\]]*)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">🖼 $1</a>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_]+)__/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
      .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>")
      .replace(/~~([^~]+)~~/g, "<del>$1</del>");
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[i]);
  }

  function table(lines) {
    const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
    const head = cells(lines[0]);
    const rows = lines.slice(2).map(cells);
    return (
      "<table><thead><tr>" + head.map((c) => `<th>${c}</th>`).join("") + "</tr></thead><tbody>" +
      rows.map((r) => "<tr>" + r.map((c) => `<td>${c}</td>`).join("") + "</tr>").join("") +
      "</tbody></table>"
    );
  }

  function render(src) {
    const lines = esc(src || "").split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(/^\s*```(.*)$/);
      if (fence) {
        const lang = fence[1].trim();
        const body = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
        i++;
        out.push(`<pre><code${lang ? ` data-lang="${lang}"` : ""}>${body.join("\n")}</code></pre>`);
        continue;
      }
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
        i++;
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        out.push("<hr>");
        i++;
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || "")) {
        const block = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) block.push(lines[i++]);
        out.push(table(block));
        continue;
      }
      if (/^&gt;\s?/.test(line)) {
        const block = [];
        while (i < lines.length && /^&gt;\s?/.test(lines[i])) block.push(lines[i++].replace(/^&gt;\s?/, ""));
        out.push(`<blockquote>${render(block.join("\n").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&quot;/g, '"').replace(/&amp;/g, "&"))}</blockquote>`);
        continue;
      }
      const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (li) {
        const ordered = /\d/.test(li[2]);
        const items = [];
        while (i < lines.length) {
          const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
          if (m) {
            const nested = m[1].length >= 2;
            items.push({ text: m[3], nested });
            i++;
          } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
            items[items.length - 1].text += " " + lines[i].trim();
            i++;
          } else break;
        }
        const tag = ordered ? "ol" : "ul";
        out.push(
          `<${tag}>` +
            items.map((it) => `<li${it.nested ? ' class="nested"' : ""}>${inline(it.text.replace(/^\[( |x)\]\s/, (_, x) => (x === "x" ? "☑ " : "☐ ")))}</li>`).join("") +
            `</${tag}>`,
        );
        continue;
      }
      if (!line.trim()) {
        i++;
        continue;
      }
      const para = [];
      while (
        i < lines.length && lines[i].trim() &&
        !/^\s*```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) &&
        !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i]) && !/^&gt;/.test(lines[i]) &&
        !/^\s*\|.*\|\s*$/.test(lines[i])
      ) {
        para.push(inline(lines[i++]));
      }
      if (para.length) out.push(`<p>${para.join("<br>")}</p>`);
      else out.push(`<p>${inline(lines[i++])}</p>`);
    }
    return out.join("\n");
  }

  window.renderMarkdown = render;
})();
