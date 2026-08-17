import { useState, useRef } from "react";
import { I18nProvider, useT } from "./i18n";
import RagChat from "./components/RagChat";
import DocumentManager from "./components/DocumentManager";
import "./App.css";

const CONVERSATION_ID_KEY = "rag_conversation_id";

function getOrCreateConversationId(): string {
  const cached = localStorage.getItem(CONVERSATION_ID_KEY);
  if (cached) return cached;
  const id = crypto.randomUUID();
  localStorage.setItem(CONVERSATION_ID_KEY, id);
  return id;
}

export default function App() {
  return (
    <I18nProvider>
      <AppInner />
    </I18nProvider>
  );
}

function AppInner() {
  const { t } = useT();
  const [activeTab, setActiveTab] = useState<"documents" | "chat">("documents");
  const conversationIdRef = useRef<string>(getOrCreateConversationId());

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-brand">
          <div className="brand-mark" />
          <div className="brand-text">
            <h1>{t("app.title")}</h1>
            <p>{t("app.subtitle")}</p>
          </div>
        </div>

        {/* ── View Navigation Tabs ── */}
        <nav className="nav-tabs">
          <button
            type="button"
            className={`tab-button ${activeTab === "documents" ? "active" : ""}`}
            onClick={() => setActiveTab("documents")}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <span>{t("nav.documents")}</span>
          </button>

          <button
            type="button"
            className={`tab-button ${activeTab === "chat" ? "active" : ""}`}
            onClick={() => setActiveTab("chat")}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span>{t("nav.chat")}</span>
          </button>
        </nav>
      </header>

      <main className="app-main">
        {activeTab === "documents" ? (
          <DocumentManager conversationId={conversationIdRef.current} />
        ) : (
          <RagChat />
        )}
      </main>
    </div>
  );
}
