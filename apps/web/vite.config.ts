import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    proxy: {
      "/health": "http://127.0.0.1:4321",
      "/ready": "http://127.0.0.1:4321",
    },
  },
});
