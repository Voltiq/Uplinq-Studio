import { Fragment, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

/*
 * The notes of a release, shown in the update dialog. They come from
 * CHANGELOG.md (the release workflow copies them into the release), so only
 * the Markdown that file uses is understood: headings, lists, paragraphs,
 * bold, italics, code and links. Taken from Inq Studio's manual viewer.
 */

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] };

export function parseNotes(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r/g, "").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }
    const item = /^(\s*)(-|\*|\d+\.)\s+(.*)$/.exec(line);
    if (item) {
      const ordered = /\d/.test(item[2]);
      const items: string[] = [];
      while (i < lines.length) {
        const next = /^(-|\*|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (next) items.push(next[2]);
        else if (/^\s+\S/.test(lines[i]) && items.length) items[items.length - 1] += " " + lines[i].trim();
        else break;
        i++;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    const text: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|[-*]\s|\d+\.\s)/.test(lines[i])) text.push(lines[i++].trim());
    blocks.push({ kind: "paragraph", text: text.join(" ") });
  }
  return blocks;
}

/** Bold, italics, code and links inside a line. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = pattern.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] != null) out.push(<strong key={key++}>{inline(m[1])}</strong>);
    else if (m[2] != null) out.push(<em key={key++}>{inline(m[2])}</em>);
    else if (m[3] != null) out.push(<code key={key++}>{m[3]}</code>);
    else if (/^https?:/.test(m[5])) {
      const url = m[5];
      out.push(
        <a
          key={key++}
          href={url}
          onClick={(e) => {
            e.preventDefault();
            openUrl(url).catch(() => {});
          }}
        >
          {m[4]}
        </a>,
      );
    } else out.push(<Fragment key={key++}>{m[4]}</Fragment>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function ReleaseNotes({ source }: { source: string }) {
  const blocks = parseNotes(source);
  if (!blocks.length) return null;
  return (
    <div className="release-notes">
      {blocks.map((b, i) => {
        if (b.kind === "heading") {
          // The version heading repeats the dialog's title.
          if (b.level <= 2) return null;
          return (
            <h4 key={i} className="release-notes-heading">
              {inline(b.text)}
            </h4>
          );
        }
        if (b.kind === "paragraph") return <p key={i}>{inline(b.text)}</p>;
        const List = b.ordered ? "ol" : "ul";
        return (
          <List key={i}>
            {b.items.map((item, n) => (
              <li key={n}>{inline(item)}</li>
            ))}
          </List>
        );
      })}
    </div>
  );
}
