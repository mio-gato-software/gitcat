import { migratePreferences } from "../shared/storage-migration";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

try { migratePreferences(localStorage); } catch { /* Storage may be unavailable. */ }

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App /></React.StrictMode>
);
