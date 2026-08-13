import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";
import "./styles.css";

if (typeof navigator !== "undefined" && "serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  });
}

if (typeof document !== "undefined") {
  createRoot(document.getElementById("root")!).render(<App />);
}
