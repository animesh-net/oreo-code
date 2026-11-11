import { Fragment, render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  effortChoices,
  effortLabel,
  shownEffort,
  type ChatMessage,
  type ToWebview,
  type ViewState,
} from '../src/shared/protocol';
import { renderMarkdown } from './markdown';
import { vscode } from './vscode';
import './styles.css';

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
  const [activity, setActivity] = useState<string[]>([]);
  const [thinking, setThinking] = useState(false);
  const [draft, setDraft] = useState(saved.draft ?? '');
  const [menuOpen, setMenuOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent<ToWebview>) => {
      const msg = event.data;
      switch (msg.type) {
        case 'state':
          setState(msg.state);
          if (!msg.state.busy) {
            setStreaming('');
            setActivity([]);
            setThinking(false);
          }
          break;
        case 'delta':
          setThinking(false);
          setStreaming((s) => s + msg.text);
          break;
        case 'activity':
          setThinking(false);
          setActivity((a) => [...a, msg.text]);
          break;
        case 'thinking':
          setThinking(true);
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

  const model = state.models.find((m) => m.id === state.selectedModel);
  const canSend = !state.busy && !!state.selectedModel && draft.trim().length > 0;
  const send = () => {
    if (!canSend) return;
    vscode.postMessage({ type: 'send', text: draft });
    setDraft('');
  };

  return (
    <div class="chat">
      <div class="messages" ref={listRef} aria-live="polite">
        {state.messages.length === 0 && !state.busy && (
          <p class="muted empty">Ask anything. Agent mode with GitHub tools comes next.</p>
        )}
        {state.messages.map((m, i) => (
          <Bubble key={i} message={m} />
        ))}
        {state.busy && (
          <Bubble
            message={{ role: 'assistant', content: streaming, activity }}
            pending={thinking ? 'Thinking…' : '…'}
          />
        )}
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

      {/* Like the Claude app: the text on top; the model and thinking pill and Send below. */}
      <footer class="composer">
        <textarea
          aria-label="Message"
          placeholder="Message Oreo Code"
          rows={2}
          value={draft}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div class="composer-row">
          {menuOpen && <button class="dismiss" aria-label="Close menu" onClick={() => setMenuOpen(false)} />}
          <div class="anchor">
            <button
              class="pill"
              aria-label="Model and thinking"
              title="Model and thinking"
              aria-expanded={menuOpen}
              disabled={state.busy || state.models.length === 0}
              onClick={() => setMenuOpen((o) => !o)}
            >
              <span class="pill-model">{model?.name ?? 'No models'}</span>
              {model && <span class="pill-effort">{effortLabel(model.thinking, state.effort)}</span>}
            </button>
            {menuOpen && (
              <div class="menu" role="menu">
                {(['macbook', 'cloudflare'] as const).map((provider) => {
                  const group = state.models.filter((m) => m.provider === provider);
                  if (!group.length) return null;
                  return (
                    <Fragment key={provider}>
                      <p class="menu-heading">{provider === 'macbook' ? 'This Mac' : 'Cloudflare (leaves the Mac)'}</p>
                      {group.map((m) => (
                        <button
                          key={m.id}
                          class="menu-item"
                          role="menuitemradio"
                          aria-checked={m.id === state.selectedModel}
                          disabled={!m.available}
                          onClick={() => vscode.postMessage({ type: 'selectModel', modelId: m.id })}
                        >
                          {m.available
                            ? m.name
                            : `${m.name} (${provider === 'macbook' ? 'not in Ollama' : 'set a Cloudflare token'})`}
                        </button>
                      ))}
                    </Fragment>
                  );
                })}
                {model && (
                  <>
                    <p class="menu-heading">Thinking</p>
                    <div class="effort" role="group" aria-label="Thinking">
                      {effortChoices(model.thinking, state.effort).map((c) => (
                        <button
                          key={c.label}
                          aria-pressed={c.value === shownEffort(model.thinking, state.effort)}
                          onClick={() => vscode.postMessage({ type: 'selectEffort', effort: c.value })}
                        >
                          {c.label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
          {state.busy ? (
            <button
              class="round stop"
              aria-label="Stop"
              title="Stop"
              onClick={() => vscode.postMessage({ type: 'stop' })}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="7" y="7" width="10" height="10" rx="1.5" />
              </svg>
            </button>
          ) : (
            <button class="round send" aria-label="Send" title="Send" disabled={!canSend} onClick={send}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 19V5M6 11l6-6 6 6" />
              </svg>
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

function Bubble({ message, pending }: { message: ChatMessage; pending?: string }) {
  return (
    <div class={`bubble ${message.role}`}>
      <div class="role">{message.role === 'user' ? 'You' : 'Oreo Code'}</div>
      {!!message.activity?.length && (
        <ul class="activity">
          {message.activity.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
      )}
      {/* Replies are Markdown, rendered with raw HTML off and http(s)-only links (markdown.ts). */}
      {message.role === 'assistant' && message.content ? (
        <div class="content markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }} />
      ) : (
        <div class="content">{message.content || pending || ''}</div>
      )}
    </div>
  );
}

render(<App />, document.getElementById('root')!);
