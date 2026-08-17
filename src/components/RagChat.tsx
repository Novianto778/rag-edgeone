import { useState, useRef, useEffect, useCallback } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { sendMessageStream, fetchConversationHistory, stopAgent } from "../api";
import CitationCard, { CitationProps } from "./CitationCard";
import { useT } from "../i18n";
import "./RagChat.css";

const CONVERSATION_ID_KEY = "rag_conversation_id";

interface MessagePart {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: string;
  output?: string;
  state?: "input-available" | "output-available";
}

interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  parts: MessagePart[];
  timestamp: number;
}

const TABLE_ROW_BOUNDARY = /\|\s+\|/g;
const TABLE_SEPARATOR_ROW = /^\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

function normalizeCompactTableLine(line: string): string {
  if (!line.includes("| |")) return line;

  const pipeIndexes = [...line.matchAll(/\|/g)]
    .map((match) => match.index ?? -1)
    .filter((index) => index >= 0);

  for (const index of pipeIndexes) {
    const table = line.slice(index);
    const normalizedTable = table.replace(TABLE_ROW_BOUNDARY, "|\n|");
    const rows = normalizedTable
      .split("\n")
      .map((row) => row.trim())
      .filter(Boolean);

    if (rows.length >= 2 && TABLE_SEPARATOR_ROW.test(rows[1])) {
      const prefix = line.slice(0, index).trimEnd();
      return prefix ? `${prefix}\n${normalizedTable}` : normalizedTable;
    }
  }

  return line;
}

function normalizeMarkdown(content: string): string {
  let inCodeFence = false;

  return content
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inCodeFence = !inCodeFence;
        return line;
      }

      return inCodeFence ? line : normalizeCompactTableLine(line);
    })
    .join("\n");
}

function getExistingConversationId() {
  return localStorage.getItem(CONVERSATION_ID_KEY);
}

function getOrCreateConversationId() {
  const cached = getExistingConversationId();
  if (cached) return cached;
  const id = crypto.randomUUID();
  localStorage.setItem(CONVERSATION_ID_KEY, id);
  return id;
}

export default function RagChat() {
  const { t } = useT();
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<"idle" | "streaming">("idle");
  const [error, setError] = useState<Error | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const abortCtrlRef = useRef<AbortController | null>(null);
  const conversationIdRef = useRef(getOrCreateConversationId());
  const currentMsgIdRef = useRef("");

  // Load history on mount
  useEffect(() => {
    if (!getExistingConversationId()) {
      setHistoryLoading(false);
      return;
    }

    let isMounted = true;
    (async () => {
      try {
        const history = await fetchConversationHistory(conversationIdRef.current);
        if (!isMounted) return;

        if (history.length > 0) {
          const restored: ChatMsg[] = history.map((item) => ({
            id: item.id || crypto.randomUUID(),
            role: item.role as "user" | "assistant",
            parts: [{ type: "text", text: item.content }],
            timestamp: item.timestamp,
          }));
          setMessages(restored);
        }
      } catch (err) {
        console.warn("Failed to load history:", err);
      } finally {
        if (isMounted) setHistoryLoading(false);
      }
    })();

    return () => {
      isMounted = false;
    };
  }, []);

  // Auto scroll to bottom
  useEffect(() => {
    if (messagesContainerRef.current) {
      messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
    }
  }, [messages, status]);

  const handleSend = useCallback(
    (text?: string) => {
      const trimmed = (text || input).trim();
      if (!trimmed) return;
      setInput("");
      setError(null);

      // Create user message
      const userMsg: ChatMsg = {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: trimmed }],
        timestamp: Date.now(),
      };

      // Create placeholder assistant message
      const botMsgId = crypto.randomUUID();
      currentMsgIdRef.current = botMsgId;
      const botMsg: ChatMsg = {
        id: botMsgId,
        role: "assistant",
        parts: [],
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, userMsg, botMsg]);
      setStatus("streaming");

      const ctrl = sendMessageStream(
        trimmed,
        {
          onTextDelta(delta) {
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== currentMsgIdRef.current) return m;
                const parts = [...m.parts];
                const lastPart = parts[parts.length - 1];
                if (lastPart && lastPart.type === "text") {
                  parts[parts.length - 1] = {
                    ...lastPart,
                    text: (lastPart.text || "") + delta,
                  };
                } else {
                  parts.push({ type: "text", text: delta });
                }
                return { ...m, parts };
              })
            );
          },

          onToolInput(toolCallId, toolName, inputData) {
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== currentMsgIdRef.current) return m;
                return {
                  ...m,
                  parts: [
                    ...m.parts,
                    {
                      type: `tool-${toolName}`,
                      toolCallId,
                      toolName,
                      input: inputData,
                      state: "input-available",
                    },
                  ],
                };
              })
            );
          },

          onToolOutput(toolCallId, output) {
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== currentMsgIdRef.current) return m;
                const parts = m.parts.map((p) => {
                  if (p.toolCallId === toolCallId && p.state === "input-available") {
                    return { ...p, output, state: "output-available" as const };
                  }
                  return p;
                });
                return { ...m, parts };
              })
            );
          },

          onFinish(stopped) {
            setStatus("idle");
            abortCtrlRef.current = null;
            if (stopped) {
              setMessages((prev) =>
                prev.map((m) => {
                  if (m.id !== currentMsgIdRef.current) return m;
                  const parts = [...m.parts];
                  const lastPart = parts[parts.length - 1];
                  if (lastPart && lastPart.type === "text") {
                    parts[parts.length - 1] = {
                      ...lastPart,
                      text: (lastPart.text || "") + "\n\n" + t("chat.stopped"),
                    };
                  } else if (parts.length === 0 || !getTextContent(parts)) {
                    parts.push({ type: "text", text: t("chat.stopped") });
                  }
                  return { ...m, parts };
                })
              );
            }
          },

          onError(err) {
            setError(err);
            setStatus("idle");
            abortCtrlRef.current = null;
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== currentMsgIdRef.current) return m;
                if (m.parts.length === 0 || getTextContent(m.parts) === "") {
                  return {
                    ...m,
                    parts: [{ type: "text", text: t("chat.error") }],
                  };
                }
                return m;
              })
            );
          },
        },
        conversationIdRef.current
      );

      abortCtrlRef.current = ctrl;
    },
    [input, t]
  );

  const handleStop = useCallback(() => {
    if (abortCtrlRef.current) {
      abortCtrlRef.current.abort();
      abortCtrlRef.current = null;
    }

    setStatus("idle");
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== currentMsgIdRef.current) return m;
        const parts = [...m.parts];
        const lastPart = parts[parts.length - 1];
        if (lastPart && lastPart.type === "text") {
          parts[parts.length - 1] = {
            ...lastPart,
            text: (lastPart.text || "") + "\n\n" + t("chat.stopped"),
          };
        } else if (parts.length === 0 || !getTextContent(parts)) {
          parts.push({ type: "text", text: t("chat.stopped") });
        }
        return { ...m, parts };
      })
    );

    stopAgent(conversationIdRef.current);
  }, [t]);

  const handleClear = useCallback(() => {
    if (status === "streaming" && abortCtrlRef.current) {
      abortCtrlRef.current.abort();
      abortCtrlRef.current = null;
    }
    setStatus("idle");
    localStorage.removeItem(CONVERSATION_ID_KEY);
    const newId = crypto.randomUUID();
    localStorage.setItem(CONVERSATION_ID_KEY, newId);
    conversationIdRef.current = newId;
    setMessages([]);
    setError(null);
  }, [status]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (status === "idle") {
        handleSend();
      }
    }
  };

  const handlePreset = (question: string) => {
    setInput("");
    handleSend(question);
  };

  const isStreaming = status === "streaming";

  const getTextContent = (parts: MessagePart[]): string => {
    if (!parts) return "";
    return parts
      .filter((p) => p.type === "text")
      .map((p) => p.text || "")
      .join("");
  };

  // Extract citations from assistant message parts
  const extractCitations = (parts: MessagePart[]): CitationProps[] => {
    if (!parts) return [];
    const citations: CitationProps[] = [];

    for (const part of parts) {
      if (part.type?.startsWith("tool-") && part.output) {
        try {
          const parsed = JSON.parse(part.output);
          if (parsed.type === "citation_pages" && Array.isArray(parsed.content)) {
            citations.push({
              docName: parsed.docName,
              docId: parsed.docId,
              pages: parsed.pages,
              pageCount: parsed.pageCount,
              totalChars: parsed.totalChars,
              content: parsed.content,
            });
          }
        } catch {
          // not JSON or not citation payload
        }
      }
    }

    return citations;
  };

  // Extract all tool execution steps for a message
  const getToolParts = (parts: MessagePart[]) => {
    if (!parts) return [];
    return parts.filter((p) => p.type?.startsWith("tool-"));
  };

  const getToolStepInfo = (toolPart: MessagePart) => {
    const isRunning = toolPart.state === "input-available";
    const toolName = toolPart.toolName || "tool";

    if (toolName === "query_knowledge_base") {
      if (isRunning) {
        return {
          isRunning: true,
          label: "Searching Qdrant Cloud & Voyage AI Reranking...",
        };
      }
      // Completed state
      let sourceCount = 0;
      if (toolPart.output) {
        try {
          const parsed = JSON.parse(toolPart.output);
          if (Array.isArray(parsed.content)) {
            sourceCount = parsed.content.length;
          }
        } catch {}
      }
      return {
        isRunning: false,
        label: sourceCount > 0
          ? `Searched Qdrant knowledge base (${sourceCount} relevant section${sourceCount > 1 ? "s" : ""} retrieved)`
          : "Searched Qdrant knowledge base (no matches)",
      };
    }

    return {
      isRunning,
      label: isRunning ? `Executing ${toolName}...` : `Completed ${toolName}`,
    };
  };

  return (
    <div className="rag-chat">
      <div className="chat-header">
        <div className="chat-header-left">
          <div className={`chat-indicator ${isStreaming ? "pulse-active" : ""}`} />
          <span className="chat-title">{t("chat.title")}</span>
        </div>
        {messages.length > 0 && (
          <button className="chat-clear-btn" onClick={handleClear}>
            {t("chat.newSession")}
          </button>
        )}
      </div>

      <div className="chat-messages" ref={messagesContainerRef}>
        {historyLoading && messages.length === 0 && (
          <div className="chat-empty">
            <div className="streaming-dots">
              <span />
              <span />
              <span />
            </div>
            <p className="chat-empty-desc" style={{ marginTop: 16 }}>
              {t("chat.loadingHistory")}
            </p>
          </div>
        )}

        {!historyLoading && messages.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
              </svg>
            </div>
            <p className="chat-empty-title">{t("chat.emptyTitle")}</p>
            <p className="chat-empty-desc">
              {t("chat.emptyDesc")}
            </p>
            <div className="preset-chips">
              {[t("preset.1"), t("preset.2")].map((q) => (
                <button
                  key={q}
                  className="preset-chip"
                  onClick={() => handlePreset(q)}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, index) => {
          const textContent = getTextContent(msg.parts);
          const toolParts = getToolParts(msg.parts);
          const hasText = textContent.trim().length > 0;
          const isLatestMessage = index === messages.length - 1;
          const isAssistantStreamingThis = isStreaming && isLatestMessage && msg.role === "assistant";
          const hasActiveTool = toolParts.some((p) => p.state === "input-available");

          return (
            <div key={msg.id} className={`chat-message chat-message--${msg.role}`}>
              <div className="message-role-tag">
                {msg.role === "user" ? t("chat.you") : t("chat.agent")}
              </div>

              {/* Tool Execution Step Badges */}
              {msg.role === "assistant" && toolParts.length > 0 && (
                <div className="tool-steps-container">
                  {toolParts.map((tp, tpIdx) => {
                    const info = getToolStepInfo(tp);
                    return (
                      <div
                        key={tp.toolCallId || tpIdx}
                        className={`tool-step-badge ${info.isRunning ? "running" : "completed"}`}
                      >
                        {info.isRunning ? (
                          <div className="tool-radar-spinner">
                            <span />
                            <span />
                          </div>
                        ) : (
                          <div className="tool-check-icon">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          </div>
                        )}
                        <span className="tool-step-label">{info.label}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Thinking dots if no text and no active tool yet while streaming */}
              {isAssistantStreamingThis && !hasText && !hasActiveTool && (
                <div className="thinking-bubble">
                  <div className="streaming-dots">
                    <span />
                    <span />
                    <span />
                  </div>
                  <span className="thinking-text">Thinking...</span>
                </div>
              )}

              {/* Message Content Bubble (only rendered when there is text) */}
              {hasText && (
                <div className="message-content">
                  {msg.role === "assistant" ? (
                    <>
                      <Markdown remarkPlugins={[remarkGfm]}>
                        {normalizeMarkdown(textContent)}
                      </Markdown>
                      {isAssistantStreamingThis && <span className="streaming-caret" />}
                    </>
                  ) : (
                    textContent
                  )}
                </div>
              )}

              {/* Citations below message */}
              {msg.role === "assistant" &&
                extractCitations(msg.parts).map((citation, idx) => (
                  <CitationCard
                    key={idx}
                    docName={citation.docName}
                    docId={citation.docId}
                    pages={citation.pages}
                    pageCount={citation.pageCount}
                    totalChars={citation.totalChars}
                    content={citation.content}
                  />
                ))}
            </div>
          );
        })}

        {error && (
          <div className="chat-error">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>{error.message || t("chat.error")}</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-bar">
        <input
          type="text"
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isStreaming ? "AI is generating response..." : t("chat.placeholder")}
        />

        {isStreaming ? (
          <button
            className="chat-stop-btn"
            onClick={handleStop}
            title={t("chat.stop")}
          >
            <span className="stop-square" />
          </button>
        ) : (
          <button
            className="chat-send-btn"
            onClick={() => handleSend()}
            disabled={!input.trim()}
            title="Send message"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
