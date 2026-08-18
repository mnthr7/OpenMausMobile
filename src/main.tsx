import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

class RootErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean; message: string }> {
  state = { failed: false, message: "" };
  static getDerivedStateFromError(error: Error) {
    return { failed: true, message: error.message };
  }
  render() {
    if (this.state.failed) {
      return (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
            padding: 24,
            textAlign: "center",
            background: "#070707",
            color: "#fcfcfc",
            font: "15px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
          }}
        >
          <div style={{ maxWidth: 420 }}>
            <div style={{ fontSize: 40 }}>🐭</div>
            <h2 style={{ fontSize: 18, fontWeight: 600, margin: "12px 0 8px" }}>OpenMausBot failed to start</h2>
            <pre
              style={{
                margin: 0,
                padding: 12,
                textAlign: "left",
                whiteSpace: "pre-wrap",
                color: "#ff5667",
                background: "#111",
                borderRadius: 8,
                font: "13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace",
              }}
            >
              {this.state.message}
            </pre>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
);
