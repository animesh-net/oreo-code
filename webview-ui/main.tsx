import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  REASONING_EFFORTS,
  type ChatMessage,
  type ReasoningEffort,
  type ToWebview,
  type ViewState,
} from '../src/shared/protocol';
import { vscode } from './vscode';
import './styles.css';

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: 'Thinking: off',
  low: 'Thinking: low',
  medium: 'Thinking: medium',
  high: 'Thinking: high',
};

const emptyState: ViewState = {
  ollamaUrl: '',
  effort: 'none',
  models: [],
  messages: [],
  busy: false,
};

interface Saved {
  draft?: string;
}

function App() {
  const saved = (vscode.getState() as Saved | undefined) ?? {};
  const [state, setState] = useState<ViewState>(emptyState);
  const [streaming, setStreaming] = useState('');
  const [draft, setDraft] = useState(saved.draft ?? '');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent<ToWebview>) => {
      const msg = event.data;
      switch (msg.type) {
        case 'state':
          setState(msg.state);
          if (!msg.state.busy) setStreaming('');
          break;
        case 'delta':
          setStreaming((s) => s + msg.text);
          break;
        case 'failed':
          setDraft((d) => (d.trim() ? d : msg.draft));
          break;
      }
    };
    window.addEventListener('message', onMessage);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    vscode.setState({ draft } satisfies Saved);
  }, [draft]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.messages, streaming]);

  const canSend = !state.busy && !!state.selectedModel && draft.trim().length > 0;
  const send = () => {
    if (!canSend) return;
    vscode.postMessage({ type: 'send', text: draft });
    setDraft('');
  };

  return (
    <div class="chat">
      <header>
        <select
          aria-label="Model"
          value={state.selectedModel ?? ''}
          disabled={state.busy || state.models.length === 0}
          onChange={(e) => vscode.postMessage({ type: 'selectModel', modelId: e.currentTarget.value })}
        >
          {state.models.length === 0 && <option value="">No models</option>}
          {state.models.map((m) => (
            <option key={m.id} value={m.id} disabled={!m.available}>
              {m.available ? m.name : `${m.name} (not in Ollama)`}
            </option>
          ))}
        </select>
        <select
          aria-label="Thinking"
          title="How long the model may think before answering"
          value={state.effort}
          disabled={state.busy || !state.selectedModel}
          onChange={(e) =>
            vscode.postMessage({ type: 'selectEffort', effort: e.currentTarget.value as ReasoningEffort })
          }
        >
          {REASONING_EFFORTS.map((effort) => (
            <option key={effort} value={effort}>
              {EFFORT_LABELS[effort]}
            </option>
          ))}
        </select>
      </header>

      <div class="messages" ref={listRef} aria-live="polite">
        {state.messages.length === 0 && !state.busy && (
          <p class="muted empty">Ask anything. Agent mode with GitHub tools comes next.</p>
        )}
        {state.messages.map((m, i) => (
          <Bubble key={i} message={m} />
        ))}
        {state.busy && <Bubble message={{ role: 'assistant', content: streaming }} pending />}
      </div>

      {state.error && (
        <div class="error banner">
          <span>{state.error}</span>
          {!state.models.some((m) => m.available) && (
            <button class="secondary" onClick={() => vscode.postMessage({ type: 'retry' })}>
              Retry
            </button>
          )}
        </div>
      )}

      <footer>
        <textarea
          aria-label="Message"
          placeholder="Message (Enter to send, Shift+Enter for a new line)"
          rows={3}
          value={draft}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        {state.busy ? (
          <button class="secondary" onClick={() => vscode.postMessage({ type: 'stop' })}>
            Stop
          </button>
        ) : (
          <button disabled={!canSend} onClick={send}>
            Send
          </button>
        )}
      </footer>
    </div>
  );
}

function Bubble({ message, pending }: { message: ChatMessage; pending?: boolean }) {
  return (
    <div class={`bubble ${message.role}`}>
      <div class="role">{message.role === 'user' ? 'You' : 'Oreo'}</div>
      {/* Rendered as plain text on purpose: model output is untrusted. */}
      <div class="content">{message.content || (pending ? '…' : '')}</div>
    </div>
  );
}

render(<App />, document.getElementById('root')!);
