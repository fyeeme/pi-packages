// Bare-label healer (runs only after Mermaid fails to parse).
//
// Authored with full TS annotations — at runtime tsx/esbuild strips them, so
// Function.prototype.toString() yields annotation-free browser-valid JS for
// injection into the rendered page (see src/page-script.ts). Invoked only
// when the original source fails to parse, so correctly-quoted source is
// NEVER rewritten. The earlier "sanitize everything up front" design
// corrupted valid input (e.g. it re-wrapped an already-correct
// `subgraph L1["…()"]`, producing double quotes and a guaranteed parse
// error). Try-first makes that class of bug structurally impossible.
export function quoteBareLabels(code: string): { code: string; fixes: string[] } {
  const fixes: string[] = [];
  const SPECIAL = /[?@<>\/&#!(){}\[\]]/;
  const SHAPES = [
    { o: "(((", c: ")))" },
    { o: "((", c: "))" },
    { o: "{{", c: "}}" },
    { o: "[[", c: "]]" },
    { o: "[(", c: ")]" },
    { o: "[/", c: "/]" },
    { o: "{", c: "}" },
    { o: "(", c: ")" },
    { o: "[", c: "]" },
  ];
  // One alternation per node; longer wrappers first so ((...)) beats (...).
  const SHAPE_RE = /(\w+)(?:\(\(\(([^)]*)\)\)\)|\(\(([^)]*)\)\)|\{\{([^}]*)\}\}|\[\[([^\]]*)\]\]|\[\(([^)]*)\)\]|\[\/([^/]*)\/\]|\{([^}]*)\}|\(([^)]*)\)|\[([^\]]*)\])/g;

  // Edge-label syntaxes Mermaid accepts on a link. Text inside any of these
  // must be quoted when it contains a special char, or the parser rejects it
  // (the "got 'LINK_ID'" / "got 'TEXT'" parse errors). Pipe is the canonical
  // form; dotted and dash are the inline-text forms. All three are protected
  // from the node pass below via placeholders, so a label like |foo(x)| is
  // never mistaken for a node shape `foo(x)`.
  const PIPE_RE = /\|([^|\n]*)\|/g; // |text|
  const DOTTED_RE = /(-\.)\s+([^\n]*?)\s+(\.-?>)/g; // -. text .->
  const DASH_RE = /(--)\s+([^\n]*?)\s+(-->|---)/g; // -- text --> / ---

  // Quote a bare edge-label text if it contains a special char. Already
  // quoted labels are left untouched.
  const healEdgeText = (text: string): { out: string; changed: boolean } => {
    const trimmed = text.trim();
    if (trimmed.charAt(0) === '"' && trimmed.slice(-1) === '"') return { out: text, changed: false };
    if (!SPECIAL.test(text)) return { out: text, changed: false };
    return { out: '"' + text.replace(/^"+|"+$/g, "").trim() + '"', changed: true };
  };

  const fixed = code.split("\n").map((line) => {
    // Subgraph: only heal a genuinely BARE label. Skip the canonical
    // `ID[...]` form, quoted forms, and bracket forms — all already safe.
    const sm = line.match(/^(\s*subgraph\s+)(.+)$/);
    if (sm) {
      const slabel = sm[2].trim();
      if (slabel.charAt(0) === '"' || slabel.charAt(0) === "[" || /^\w+\s*\[/.test(slabel)) return line;
      if (SPECIAL.test(slabel)) {
        fixes.push("subgraph " + slabel);
        return sm[1] + "sg" + fixes.length + ' ["' + slabel + '"]';
      }
      return line;
    }

    // Protect every edge label with a placeholder BEFORE the node pass, so
    // a label like |foo(x)| or -- foo(x) --> is never mistaken for a node
    // shape `foo(x)`. The node pass runs on the placeholder line and the
    // real labels are restored afterwards.
    const stash: string[] = [];
    const park = (s: string) => { stash.push(s); return "\x00E" + (stash.length - 1) + "\x00"; };

    let work = line.replace(PIPE_RE, (m, text) => {
      const h = healEdgeText(text);
      if (!h.changed) return park(m);
      fixes.push("edge |" + text.trim() + "|");
      return park("|" + h.out + "|");
    });
    work = work.replace(DOTTED_RE, (m, pre, text, post) => {
      const h = healEdgeText(text);
      if (!h.changed) return park(m);
      fixes.push("edge -. " + text.trim() + " " + post);
      return park(pre + " " + h.out + " " + post);
    });
    work = work.replace(DASH_RE, (m, pre, text, post) => {
      const h = healEdgeText(text);
      if (!h.changed) return park(m);
      fixes.push("edge -- " + text.trim() + " " + post);
      return park(pre + " " + h.out + " " + post);
    });

    // Nodes: quote bare labels containing special chars. Labels that are
    // already double-quoted are left untouched (defence in depth — though
    // this path only runs after a parse failure anyway).
    work = work.replace(SHAPE_RE, (match, id, ...groups) => {
      const idx = groups.findIndex((g) => g !== undefined);
      if (idx < 0) return match;
      const shape = SHAPES[idx];
      const label = String(groups[idx]);
      const trimmed = label.trim();
      if (trimmed.charAt(0) === '"' && trimmed.slice(-1) === '"') return match;
      if (!SPECIAL.test(label)) return match;
      fixes.push(id + " " + shape.o + "…" + shape.c);
      const clean = label.replace(/^"+|"+$/g, "").trim();
      return id + shape.o + '"' + clean + '"' + shape.c;
    });

    // Restore the protected edge labels.
    return work.replace(/\x00E(\d+)\x00/g, (_m, i) => stash[Number(i)]);
  }).join("\n");

  return { code: fixed, fixes };
}
