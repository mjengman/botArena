import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./app/app.css";
import { App } from "./app/App.tsx";

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
