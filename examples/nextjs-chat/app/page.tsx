"use client";

import { useChat } from "ai/react";

export default function Page(): React.ReactElement {
  const { messages, input, handleInputChange, handleSubmit, isLoading } =
    useChat({ api: "/api/chat" });

  return (
    <main
      style={{
        maxWidth: 720,
        margin: "0 auto",
        padding: 24,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>
        TokSuan × Next.js — minimal chat
      </h1>
      <p style={{ fontSize: 13, color: "#666", marginBottom: 24 }}>
        Every message routes through the TokSuan gateway. Open the dashboard
        at http://localhost:3000 to see costs land in real time.
      </p>

      <div style={{ display: "grid", gap: 12, marginBottom: 16 }}>
        {messages.map((m) => (
          <div
            key={m.id}
            style={{
              padding: "10px 12px",
              borderRadius: 8,
              background: m.role === "user" ? "#eef" : "#efe",
              fontSize: 14,
            }}
          >
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                marginBottom: 4,
                color: "#444",
              }}
            >
              {m.role}
            </div>
            <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
          </div>
        ))}
      </div>

      <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8 }}>
        <input
          value={input}
          onChange={handleInputChange}
          placeholder="Say something..."
          style={{
            flex: 1,
            padding: "10px 12px",
            border: "1px solid #ccc",
            borderRadius: 8,
            fontSize: 14,
          }}
        />
        <button
          type="submit"
          disabled={isLoading}
          style={{
            padding: "10px 16px",
            background: "#0070f3",
            color: "white",
            border: "none",
            borderRadius: 8,
            fontSize: 14,
            cursor: isLoading ? "not-allowed" : "pointer",
            opacity: isLoading ? 0.6 : 1,
          }}
        >
          Send
        </button>
      </form>
    </main>
  );
}
