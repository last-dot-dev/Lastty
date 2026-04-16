const NON_BREAKING_SPACE = /\u00a0/g;

export interface SelectionBufferCell {
  getWidth(): number;
}

export interface SelectionBufferLine {
  readonly isWrapped: boolean;
  readonly length: number;
  getCell(x: number): SelectionBufferCell | undefined;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

export interface SelectionBuffer {
  getLine(y: number): SelectionBufferLine | undefined;
}

export interface BufferPosition {
  column: number;
  line: number;
}

export interface BufferRange {
  start: BufferPosition;
  end: BufferPosition;
}

export interface TerminalSelectionPosition {
  x: number;
  y: number;
}

export interface TerminalSelectionRange {
  start: TerminalSelectionPosition;
  end: TerminalSelectionPosition;
}

export interface TerminalSelectionSource {
  buffer: {
    active: SelectionBuffer;
  };
  getSelectionPosition(): TerminalSelectionRange | undefined;
}

export interface ClipboardDataWriter {
  setData(format: string, value: string): void;
}

export interface ClipboardSelectionEvent {
  clipboardData?: ClipboardDataWriter | null;
  preventDefault(): void;
}

export function readSelectionText(buffer: SelectionBuffer, range: BufferRange): string {
  const ordered = orderRange(range);
  const segments: string[] = [];

  for (let lineIndex = ordered.start.line; lineIndex <= ordered.end.line; lineIndex += 1) {
    const line = buffer.getLine(lineIndex);
    if (!line) continue;

    const startColumn =
      lineIndex === ordered.start.line ? normalizeStartColumn(line, ordered.start.column) : 0;
    const endColumn =
      lineIndex === ordered.end.line ? normalizeEndColumn(line, ordered.end.column) : line.length;
    const text = line.translateToString(true, startColumn, endColumn);

    if (segments.length > 0 && line.isWrapped) {
      segments[segments.length - 1] += text;
    } else {
      segments.push(text);
    }
  }

  return segments.join("\n").replace(NON_BREAKING_SPACE, " ");
}

export function readTerminalSelection(source: TerminalSelectionSource): string {
  const selection = source.getSelectionPosition();
  if (!selection) {
    return "";
  }

  return readSelectionText(source.buffer.active, {
    start: {
      column: selection.start.x,
      line: selection.start.y,
    },
    end: {
      column: selection.end.x,
      line: selection.end.y,
    },
  });
}

export function writeSelectionToClipboard(
  source: TerminalSelectionSource,
  event: ClipboardSelectionEvent,
): boolean {
  const text = readTerminalSelection(source);
  if (!text || !event.clipboardData) {
    return false;
  }

  event.clipboardData.setData("text/plain", text);
  event.preventDefault();
  return true;
}

function orderRange(range: BufferRange): BufferRange {
  if (comparePositions(range.start, range.end) <= 0) {
    return range;
  }
  return { start: range.end, end: range.start };
}

function comparePositions(left: BufferPosition, right: BufferPosition): number {
  if (left.line !== right.line) {
    return left.line - right.line;
  }
  return left.column - right.column;
}

function normalizeStartColumn(line: SelectionBufferLine, column: number): number {
  let normalized = clamp(column, 0, line.length);
  while (normalized > 0 && line.getCell(normalized)?.getWidth() === 0) {
    normalized -= 1;
  }
  return normalized;
}

function normalizeEndColumn(line: SelectionBufferLine, column: number): number {
  let normalized = clamp(column, 0, line.length);
  while (normalized < line.length && line.getCell(normalized)?.getWidth() === 0) {
    normalized += 1;
  }
  return normalized;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
