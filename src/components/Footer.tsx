import type { Editor } from '@tiptap/react';

interface FooterProps {
  editor: Editor | null;
  filePath: string | null;
  isSuggesting: boolean;
  isDirty?: boolean;
  zoom?: number;
  onZoomChange?: (z: number) => void;
}

function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

export default function Footer({ editor, filePath, isSuggesting, isDirty, zoom = 1, onZoomChange }: FooterProps) {
  if (!editor) return <div className="footer" />;

  const text = editor.state.doc.textContent;
  const words = countWords(text);
  const chars = text.length;

  const { from } = editor.state.selection;
  const resolved = editor.state.doc.resolve(from);
  const line = Math.max(1, resolved.depth);
  const col = resolved.parentOffset + 1;

  const fileName = filePath ? filePath.split('/').pop() : 'Untitled';

  return (
    <div className="footer">
      <span className="footer-filename">{fileName}{isDirty && <span className="footer-dirty">•</span>}</span>
      <span className="footer-sep">·</span>
      <span>{words.toLocaleString()} words</span>
      <span className="footer-sep">·</span>
      <span>{chars.toLocaleString()} chars</span>
      <span className="footer-sep">·</span>
      <span>
        Line {line}, Col {col}
      </span>
      {isSuggesting && (
        <>
          <span className="footer-sep">·</span>
          <span className="footer-suggesting-badge">Suggesting</span>
        </>
      )}
      <div className="footer-zoom">
        <input
          type="range"
          min={0.6}
          max={2.4}
          step={0.06}
          value={zoom}
          onChange={(e) => onZoomChange?.(parseFloat(e.target.value))}
          className="footer-zoom-slider"
          title="Zoom"
        />
        <span className="footer-zoom-label" onDoubleClick={() => onZoomChange?.(1)}>
          {Math.round(zoom * 100)}%
        </span>
      </div>
    </div>
  );
}
