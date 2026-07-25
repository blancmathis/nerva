import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initializeReviewStore } from "./lib/review-store";
import { startPwaUpdateMonitor } from "./lib/pwa-updates";
import "./styles.css";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/studios.css";
import "./styles/site-experience.css";
import "./styles/status-lighting.css";
import "./styles/capture-inbox.css";

// Storage maintenance is independent of pairing, connectivity, and native
// slot discovery. Opening version 6 here purges legacy PWA audio stores even
// when the application remains on the pairing or offline screen.
void initializeReviewStore().catch(() => undefined);

const root = document.getElementById("root");
if (!root) throw new Error("Nerva root element is missing");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

startPwaUpdateMonitor();
