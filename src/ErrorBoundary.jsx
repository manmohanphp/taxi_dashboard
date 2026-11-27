import React from "react";
import { AlertCircle, RefreshCw } from "lucide-react";

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch() {
    // eslint-disable-next-line no-console
    console.error("The dashboard encountered a render error.");
  }
  handleReset = () => {
    this.setState({ hasError: false });
    if (typeof window !== "undefined") window.location.reload();
  };
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, background: "#f4f7fb", color: "#18243a", fontFamily: "DM Sans, sans-serif" }}>
          <div style={{ maxWidth: 560, background: "#fff", border: "1px solid #e8edf5", borderRadius: 12, padding: 28, boxShadow: "0 8px 30px rgba(0,0,0,.06)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <AlertCircle size={22} color="#ad3b42" />
              <h1 style={{ margin: 0, fontSize: 20 }}>Something went wrong</h1>
            </div>
            <p style={{ color: "#5f6e83", lineHeight: 1.5 }}>The dashboard hit an unexpected error. You can reload to continue.</p>
            <button onClick={this.handleReset} style={{ marginTop: 14, display: "inline-flex", alignItems: "center", gap: 8, padding: "9px 14px", borderRadius: 8, border: 0, background: "#2563eb", color: "#fff", cursor: "pointer", fontWeight: 600 }}>
              <RefreshCw size={15} /> Reload dashboard
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
