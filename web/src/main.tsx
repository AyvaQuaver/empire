import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./styles.css";
import App from "./App";

declare global {
  interface Window {
    __empireMounted?: boolean;
  }
}
window.__empireMounted = true; // tells the asset watchdog the app actually booted

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
