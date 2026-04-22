/** Minimal unified-diff parser. Good enough for v1. */

export interface DiffLine {
  kind: "add" | "del" | "ctx";
  oldNum: number | null;
  newNum: number | null;
  content: string;
}
export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}
export interface DiffFile {
  oldPath: string;
  newPath: string;
  hunks: DiffHunk[];
  binary: boolean;
}

export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = text.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("diff --git ")) {
      const file: DiffFile = { oldPath: "", newPath: "", hunks: [], binary: false };
      // parse a/path b/path
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (m) { file.oldPath = m[1]!; file.newPath = m[2]!; }
      i++;
      // Consume header until first hunk or next file
      while (i < lines.length && !lines[i]!.startsWith("@@") && !lines[i]!.startsWith("diff --git ")) {
        const l = lines[i]!;
        if (l.startsWith("--- a/")) file.oldPath = l.slice(6);
        else if (l.startsWith("--- ")) file.oldPath = l.slice(4);
        if (l.startsWith("+++ b/")) file.newPath = l.slice(6);
        else if (l.startsWith("+++ ")) file.newPath = l.slice(4);
        if (l.startsWith("Binary files")) file.binary = true;
        i++;
      }
      // Parse hunks
      while (i < lines.length && lines[i]!.startsWith("@@")) {
        const hunkHeader = lines[i]!;
        i++;
        const hm = hunkHeader.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
        let oldNum = hm ? parseInt(hm[1]!, 10) : 0;
        let newNum = hm ? parseInt(hm[3]!, 10) : 0;
        const hunk: DiffHunk = { header: hunkHeader, lines: [] };
        while (i < lines.length && !lines[i]!.startsWith("@@") && !lines[i]!.startsWith("diff --git ")) {
          const l = lines[i]!;
          if (l.startsWith("\\ No newline")) { i++; continue; }
          if (l.startsWith("+")) {
            hunk.lines.push({ kind: "add", oldNum: null, newNum, content: l.slice(1) });
            newNum++;
          } else if (l.startsWith("-")) {
            hunk.lines.push({ kind: "del", oldNum, newNum: null, content: l.slice(1) });
            oldNum++;
          } else if (l.startsWith(" ")) {
            hunk.lines.push({ kind: "ctx", oldNum, newNum, content: l.slice(1) });
            oldNum++; newNum++;
          } else if (l === "") {
            // blank between files — bail
            break;
          } else {
            // unrecognized — stop this hunk
            break;
          }
          i++;
        }
        file.hunks.push(hunk);
      }
      files.push(file);
    } else {
      i++;
    }
  }
  return files;
}
