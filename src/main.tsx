import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { loadSettings } from "./lib/storage";
import { resolveTheme, setPageTheme } from "./lib/theme";
import "./styles/tokens.css";
import "./styles/app.css";

// Colour the page before the first render, so it never flashes the wrong theme.
setPageTheme(resolveTheme(loadSettings().theme));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
