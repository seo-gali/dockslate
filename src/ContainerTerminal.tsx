import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { backend, type Container } from './api';
import { errorMessage } from './components';

type Cell = { text: string; fg: string; bg: string; bold: boolean; inverse: boolean };
type Output = { bytes: number[]; cursor: number; truncated: boolean; exited: boolean; exitCode: number | null };
const colors = ['#17202b', '#f07878', '#53cf9f', '#e4bf69', '#79afff', '#c392f0', '#6ccbd1', '#d8e0ec', '#71839b', '#ff9b9b', '#81e9b9', '#f9d98b', '#a3c9ff', '#e2b3ff', '#9eebee', '#ffffff'];
const blank = (): Cell => ({ text: ' ', fg: '#d8e0ec', bg: 'transparent', bold: false, inverse: false });

class Screen {
  lines: Cell[][] = []; history: Cell[][] = []; row = 0; col = 0; saved = [0, 0]; style = blank();
  pending = ''; mode: 'text' | 'escape' | 'csi' | 'osc' | 'oscEscape' = 'text'; wrap = true; cursorVisible = true;
  bracketedPaste = false; alternate: { lines: Cell[][]; row: number; col: number } | null = null;
  scrollTop = 0; scrollBottom: number;
  constructor(public cols: number, public rows: number) { this.scrollBottom = rows - 1; this.lines = Array.from({ length: rows }, () => this.empty()); }
  empty() { return Array.from({ length: this.cols }, blank); }
  resize(cols: number, rows: number) {
    this.cols = cols; this.rows = rows;
    this.lines = this.lines.slice(0, rows).map(line => [...line.slice(0, cols), ...Array.from({ length: Math.max(0, cols - line.length) }, blank)]);
    while (this.lines.length < rows) this.lines.push(this.empty());
    this.row = Math.min(this.row, rows - 1); this.col = Math.min(this.col, cols - 1); this.scrollTop = 0; this.scrollBottom = rows - 1;
  }
  newline() {
    this.col = Math.min(this.col, this.cols - 1);
    if (this.row < this.scrollBottom) { this.row++; return; }
    const removed = this.lines.splice(this.scrollTop, 1)[0];
    this.lines.splice(this.scrollBottom, 0, this.empty());
    if (!this.alternate && this.scrollTop === 0) { this.history.push(removed); if (this.history.length > 200) this.history.shift(); }
  }
  reverseLine() { if (this.row > this.scrollTop) this.row--; else { this.lines.splice(this.scrollBottom, 1); this.lines.splice(this.scrollTop, 0, this.empty()); } }
  color(value: number) { return colors[Math.max(0, Math.min(15, value))]; }
  extended(values: number[], index: number): [string | null, number] {
    if (values[index] === 2 && values.length > index + 3) return [`rgb(${values.slice(index + 1, index + 4).map(v => Math.max(0, Math.min(255, v))).join(',')})`, index + 3];
    if (values[index] === 5 && values.length > index + 1) {
      const value = Math.max(0, Math.min(255, values[index + 1]));
      if (value < 16) return [this.color(value), index + 1];
      if (value >= 232) { const gray = 8 + (value - 232) * 10; return [`rgb(${gray},${gray},${gray})`, index + 1]; }
      const n = value - 16; const levels = [0, 95, 135, 175, 215, 255];
      return [`rgb(${levels[Math.floor(n / 36)]},${levels[Math.floor(n / 6) % 6]},${levels[n % 6]})`, index + 1];
    }
    return [null, index];
  }
  csi(sequence: string, reply: (value: string) => void) {
    const final = sequence.slice(-1); const body = sequence.slice(0, -1); const privateMode = body.startsWith('?');
    const values = body.replace(/^[?>!]/, '').split(';').map(value => Number.parseInt(value, 10) || 0); const amount = values[0] || 1;
    const clamp = () => { this.row = Math.max(0, Math.min(this.rows - 1, this.row)); this.col = Math.max(0, Math.min(this.cols - 1, this.col)); };
    if (final === 'A') this.row -= amount;
    else if (final === 'B' || final === 'e') this.row += amount;
    else if (final === 'C' || final === 'a') this.col += amount;
    else if (final === 'D') this.col -= amount;
    else if (final === 'E') { this.row += amount; this.col = 0; }
    else if (final === 'F') { this.row -= amount; this.col = 0; }
    else if (final === 'G' || final === '`') this.col = amount - 1;
    else if (final === 'd') this.row = amount - 1;
    else if (final === 'H' || final === 'f') { this.row = amount - 1; this.col = (values[1] || 1) - 1; }
    else if (final === 's') this.saved = [this.row, this.col];
    else if (final === 'u') [this.row, this.col] = this.saved;
    else if (final === 'K') {
      const start = values[0] === 1 || values[0] === 2 ? 0 : this.col; const end = values[0] === 1 ? this.col + 1 : this.cols;
      for (let column = start; column < end; column++) this.lines[this.row][column] = blank();
    } else if (final === 'J') {
      if (values[0] === 2 || values[0] === 3) { this.lines = Array.from({ length: this.rows }, () => this.empty()); if (values[0] === 3) this.history = []; }
      else if (values[0] === 1) { for (let row = 0; row <= this.row; row++) for (let col = 0; col < (row === this.row ? this.col + 1 : this.cols); col++) this.lines[row][col] = blank(); }
      else for (let row = this.row; row < this.rows; row++) for (let col = row === this.row ? this.col : 0; col < this.cols; col++) this.lines[row][col] = blank();
    } else if (final === 'P') { this.lines[this.row].splice(this.col, amount); while (this.lines[this.row].length < this.cols) this.lines[this.row].push(blank()); }
    else if (final === '@') { this.lines[this.row].splice(this.col, 0, ...Array.from({ length: Math.min(amount, this.cols) }, blank)); this.lines[this.row].length = this.cols; }
    else if (final === 'X') { for (let col = this.col; col < Math.min(this.col + amount, this.cols); col++) this.lines[this.row][col] = blank(); }
    else if (final === 'L') { this.lines.splice(this.row, 0, ...Array.from({ length: Math.min(amount, this.rows - this.row) }, () => this.empty())); this.lines.length = this.rows; }
    else if (final === 'M') { this.lines.splice(this.row, Math.min(amount, this.rows - this.row)); while (this.lines.length < this.rows) this.lines.push(this.empty()); }
    else if (final === 'r') { this.scrollTop = Math.max(0, Math.min(this.rows - 1, amount - 1)); this.scrollBottom = Math.max(this.scrollTop, Math.min(this.rows - 1, (values[1] || this.rows) - 1)); this.row = this.scrollTop; this.col = 0; }
    else if (final === 'S') for (let n = 0; n < Math.min(amount, this.rows); n++) { this.lines.splice(this.scrollTop, 1); this.lines.splice(this.scrollBottom, 0, this.empty()); }
    else if (final === 'T') for (let n = 0; n < Math.min(amount, this.rows); n++) { this.lines.splice(this.scrollBottom, 1); this.lines.splice(this.scrollTop, 0, this.empty()); }
    else if (final === 'n' && amount === 6) reply(`\x1b[${this.row + 1};${this.col + 1}R`);
    else if (final === 'n' && amount === 5) reply('\x1b[0n');
    else if (final === 'c') reply('\x1b[?1;2c');
    else if ((final === 'h' || final === 'l') && privateMode) {
      const enabled = final === 'h';
      for (const value of values) {
        if (value === 25) this.cursorVisible = enabled;
        if (value === 7) this.wrap = enabled;
        if (value === 2004) this.bracketedPaste = enabled;
        if ([47, 1047, 1049].includes(value)) {
          if (enabled && !this.alternate) { this.alternate = { lines: this.lines, row: this.row, col: this.col }; this.lines = Array.from({ length: this.rows }, () => this.empty()); this.row = 0; this.col = 0; }
          else if (!enabled && this.alternate) { this.lines = this.alternate.lines; this.row = this.alternate.row; this.col = this.alternate.col; this.alternate = null; this.resize(this.cols, this.rows); }
        }
      }
    } else if (final === 'm') {
      for (let index = 0; index < values.length; index++) {
        const value = values[index];
        if (value === 0) this.style = blank(); else if (value === 1) this.style.bold = true; else if (value === 22) this.style.bold = false;
        else if (value === 7) this.style.inverse = true; else if (value === 27) this.style.inverse = false;
        else if (value >= 30 && value <= 37) this.style.fg = this.color(value - 30); else if (value >= 90 && value <= 97) this.style.fg = this.color(value - 90 + 8);
        else if (value >= 40 && value <= 47) this.style.bg = this.color(value - 40); else if (value >= 100 && value <= 107) this.style.bg = this.color(value - 100 + 8);
        else if (value === 39) this.style.fg = blank().fg; else if (value === 49) this.style.bg = 'transparent';
        else if (value === 38 || value === 48) { const [color, end] = this.extended(values, index + 1); if (color) this.style[value === 38 ? 'fg' : 'bg'] = color; index = end; }
      }
    }
    clamp();
  }
  feed(text: string, reply: (value: string) => void) {
    for (const character of text) {
      if (this.mode === 'osc') { if (character === '\x07') this.mode = 'text'; else if (character === '\x1b') this.mode = 'oscEscape'; continue; }
      if (this.mode === 'oscEscape') { this.mode = character === '\\' ? 'text' : 'osc'; continue; }
      if (this.mode === 'escape') {
        this.mode = 'text';
        if (character === '[') { this.pending = ''; this.mode = 'csi'; }
        else if (character === ']') this.mode = 'osc';
        else if (character === '7') this.saved = [this.row, this.col];
        else if (character === '8') [this.row, this.col] = this.saved;
        else if (character === 'D') this.newline(); else if (character === 'M') this.reverseLine();
        else if (character === 'E') { this.col = 0; this.newline(); }
        else if (character === 'c') { this.lines = Array.from({ length: this.rows }, () => this.empty()); this.row = this.col = 0; this.style = blank(); }
        else if (['(', ')', '*', '+'].includes(character)) { this.pending = 'charset'; this.mode = 'csi'; }
        continue;
      }
      if (this.mode === 'csi') {
        if (this.pending === 'charset') { this.pending = ''; this.mode = 'text'; continue; }
        this.pending += character;
        if (character >= '@' && character <= '~') { this.csi(this.pending, reply); this.pending = ''; this.mode = 'text'; }
        else if (this.pending.length > 128) { this.pending = ''; this.mode = 'text'; }
        continue;
      }
      if (character === '\x1b') { this.mode = 'escape'; continue; }
      if (character === '\r') { this.col = 0; continue; } if (character === '\n' || character === '\v' || character === '\f') { this.newline(); continue; }
      if (character === '\b') { this.col = Math.max(0, this.col - 1); continue; } if (character === '\t') { this.col = Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8); continue; }
      if (character < ' ' || character === '\x7f') continue;
      const code = character.codePointAt(0) || 0;
      if (/\p{Mark}/u.test(character)) { if (this.col > 0) { const cell = this.lines[this.row][Math.min(this.col - 1, this.cols - 1)]; if (cell.text.length < 32) cell.text += character; } continue; }
      const width = code >= 0x1100 && (code <= 0x115f || code >= 0x2e80 && code <= 0xa4cf || code >= 0xac00 && code <= 0xd7a3 || code >= 0xf900 && code <= 0xfaff || code >= 0xff01 && code <= 0xff60 || code >= 0x1f300) ? 2 : 1;
      if (this.col + width > this.cols) { if (this.wrap) { this.col = 0; this.newline(); } else this.col = this.cols - width; }
      this.lines[this.row][this.col] = { ...this.style, text: character }; if (width === 2) this.lines[this.row][this.col + 1] = { ...this.style, text: '' };
      this.col += width;
    }
  }
}

function renderLine(line: Cell[], index: number, cursor: number | null) {
  const spans: { text: string; style: CSSProperties; key: number }[] = [];
  let last = '';
  for (let col = 0; col < line.length; col++) {
    const cell = line[col]; const focused = cursor === col;
    const fg = cell.inverse ? cell.bg === 'transparent' ? '#0b1016' : cell.bg : cell.fg;
    const bg = focused ? '#96b5df' : cell.inverse ? cell.fg : cell.bg;
    const key = `${fg}:${bg}:${cell.bold}:${focused}`;
    if (key === last && spans.length) spans[spans.length - 1].text += cell.text;
    else { spans.push({ text: cell.text, style: { color: focused ? '#0b1016' : fg, backgroundColor: bg, fontWeight: cell.bold ? 700 : 400 }, key: col }); last = key; }
  }
  return <div key={index} style={{ height: '1.4em', whiteSpace: 'pre' }}>{spans.map(span => <span key={span.key} style={span.style}>{span.text}</span>)}</div>;
}

export function ContainerTerminal({ container, active }: { container: Container; active: boolean }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [shell, setShell] = useState('sh');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [ended, setEnded] = useState<string | null>(null);
  const [, redraw] = useState(0);
  const screen = useRef(new Screen(100, 24));
  const decoder = useRef(new TextDecoder('utf-8'));
  const cursor = useRef(0);
  const session = useRef<string | null>(null);
  const epoch = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const pendingInput = useRef(Promise.resolve());
  const queuedInput = useRef(0);
  const send = useCallback((data: string) => {
    const id = session.current; if (!id || !data) return;
    if (queuedInput.current + data.length > 65536) { setFailure('입력 대기열이 가득 찼습니다. 잠시 뒤 다시 입력하세요.'); return; }
    queuedInput.current += data.length;
    pendingInput.current = pendingInput.current.then(async () => {
      const characters = Array.from(data);
      for (let offset = 0; offset < characters.length; offset += 2048) {
        if (session.current !== id) return;
        await backend('terminal_input', { sessionId: id, data: characters.slice(offset, offset + 2048).join('') });
      }
    }).catch(error => setFailure(errorMessage(error))).finally(() => { queuedInput.current -= data.length; });
  }, []);
  const close = useCallback(async () => {
    const id = session.current; session.current = null; setSessionId(null); epoch.current++;
    if (id) try { await backend('terminal_close', { sessionId: id }); } catch (error) { setFailure(errorMessage(error)); }
  }, []);
  useEffect(() => {
    setSessionId(null); setEnded(null); setFailure(null); screen.current = new Screen(screen.current.cols, screen.current.rows); decoder.current = new TextDecoder('utf-8'); cursor.current = 0; redraw(n => n + 1);
    return () => { const id = session.current; session.current = null; epoch.current++; if (id) void backend('terminal_close', { sessionId: id }).catch(() => {}); };
  }, [container.id]);
  const open = async () => {
    const version = ++epoch.current; setBusy(true); setFailure(null); setEnded(null);
    try {
      const opened = await backend<{ sessionId: string }>('terminal_open', { id: container.id, shell, cols: screen.current.cols, rows: screen.current.rows });
      if (version !== epoch.current) { await backend('terminal_close', { sessionId: opened.sessionId }); return; }
      screen.current = new Screen(screen.current.cols, screen.current.rows); decoder.current = new TextDecoder('utf-8'); cursor.current = 0;
      session.current = opened.sessionId; setSessionId(opened.sessionId); redraw(n => n + 1); input.current?.focus();
    } catch (error) { setFailure(errorMessage(error)); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    if (!active || !sessionId) return;
    input.current?.focus();
    let cancelled = false; let timer = 0;
    const poll = async () => {
      try {
        const result = await backend<Output>('terminal_read', { sessionId, cursor: cursor.current });
        if (cancelled || session.current !== sessionId) return;
        if (result.truncated) { decoder.current = new TextDecoder('utf-8'); screen.current.feed('\r\n[이전 출력 일부가 버퍼에서 제외되었습니다.]\r\n', send); }
        cursor.current = result.cursor;
        if (result.bytes.length) {
          screen.current.feed(decoder.current.decode(Uint8Array.from(result.bytes), { stream: true }), send);
          redraw(n => n + 1); if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
        }
        if (result.exited) { setEnded(`셸이 종료되었습니다${result.exitCode === null ? '' : ` (종료 코드 ${result.exitCode})`}.`); await close(); return; }
      } catch (error) { if (!cancelled) { setFailure(errorMessage(error)); await close(); } return; }
      if (!cancelled) timer = window.setTimeout(poll, 250);
    };
    void poll(); return () => { cancelled = true; window.clearTimeout(timer); };
  }, [active, sessionId, close, send]);
  useEffect(() => {
    if (!active || !viewport.current) return;
    let timer = 0;
    const observer = new ResizeObserver(entries => {
      window.clearTimeout(timer);
      const width = entries[0]?.contentRect.width || 800;
      timer = window.setTimeout(() => {
        const cols = Math.max(20, Math.min(240, Math.floor((width - 24) / 7.82)));
        if (cols === screen.current.cols) return;
        screen.current.resize(cols, 24); redraw(n => n + 1);
        const id = session.current; if (id) void backend('terminal_resize', { sessionId: id, cols, rows: 24 }).catch(error => setFailure(errorMessage(error)));
      }, 150);
    });
    observer.observe(viewport.current); return () => { observer.disconnect(); window.clearTimeout(timer); };
  }, [active]);
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!session.current || event.nativeEvent.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'v') return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return;
    let data = '';
    if (event.ctrlKey && !event.altKey && /^[a-z]$/i.test(event.key)) data = String.fromCharCode(event.key.toUpperCase().charCodeAt(0) - 64);
    else if (event.ctrlKey && event.key === ' ') data = '\0';
    else data = ({ Enter: '\r', Backspace: '\x7f', Tab: event.shiftKey ? '\x1b[Z' : '\t', Escape: '\x1b', ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D', Home: '\x1b[H', End: '\x1b[F', Delete: '\x1b[3~', PageUp: '\x1b[5~', PageDown: '\x1b[6~', F1: '\x1bOP', F2: '\x1bOQ', F3: '\x1bOR', F4: '\x1bOS' } as Record<string, string>)[event.key] || '';
    if (data) { event.preventDefault(); send(data); }
    else if (event.altKey && event.key.length === 1) { event.preventDefault(); send(`\x1b${event.key}`); }
  };
  const terminal = screen.current;
  return <section aria-label="컨테이너 터미널" style={{ display: 'grid', gap: 12 }}>
    <div className="toolbar"><label className="muted">셸 <select aria-label="컨테이너 셸" value={shell} onChange={event => setShell(event.target.value)} disabled={busy || !!sessionId}><option value="sh">/bin/sh</option><option value="bash">/bin/bash</option></select></label>{sessionId ? <><button className="button" onClick={() => send('\x03')}>Ctrl+C</button><button className="button" onClick={() => void close()}>터미널 종료</button></> : <button className="button primary" disabled={busy || container.state !== 'running'} onClick={() => void open()}>{busy ? '연결 중…' : '터미널 연결'}</button>}</div>
    <p className="muted">{container.name} 내부의 대화형 셸입니다. 입력한 명령은 이 컨테이너에서 실행됩니다. 셸이 없는 이미지는 연결할 수 없습니다.</p>
    {failure && <div className="notice error" role="alert">{failure}</div>}{ended && <p role="status" className="muted">{ended}</p>}
    <div ref={viewport} onClick={() => input.current?.focus()} style={{ position: 'relative', overflow: 'auto', maxHeight: 520, minHeight: 390, background: '#090d12', color: '#d8e0ec', border: '1px solid #2b3b4f', borderRadius: 6, padding: 12, fontFamily: 'Consolas, "Cascadia Mono", monospace', fontSize: '1rem', lineHeight: 1.4, cursor: 'text', userSelect: 'text' }} aria-label="터미널 화면" role="log" aria-live="off">
      {!terminal.alternate && terminal.history.map((line, index) => renderLine(line, index - terminal.history.length, null))}
      {terminal.lines.map((line, index) => renderLine(line, index, sessionId && active && terminal.cursorVisible && index === terminal.row ? Math.min(terminal.col, terminal.cols - 1) : null))}
      <textarea ref={input} aria-label="터미널 입력" disabled={!sessionId || !active} autoComplete="off" autoCapitalize="off" spellCheck={false} onKeyDown={keyDown} onChange={event => { if (!(event.nativeEvent as InputEvent).isComposing && event.target.value) { send(event.target.value); event.target.value = ''; } }} onCompositionEnd={event => { if (event.currentTarget.value) { send(event.currentTarget.value); event.currentTarget.value = ''; } }} onPaste={event => { event.preventDefault(); const text = event.clipboardData.getData('text'); if (text.length > 65536) { setFailure('붙여넣기는 한 번에 64KB까지 사용할 수 있습니다.'); return; } send(screen.current.bracketedPaste ? `\x1b[200~${text}\x1b[201~` : text); }} style={{ position: 'absolute', left: 12, bottom: 0, opacity: 0, width: 1, height: 1, padding: 0 }} />
    </div>
    <p className="muted">화면을 누른 뒤 입력하세요. Enter·방향키·Backspace·Ctrl+C를 사용할 수 있습니다. 보관 범위는 출력 1MB, 화면 기록 200줄입니다.</p>
  </section>;
}
