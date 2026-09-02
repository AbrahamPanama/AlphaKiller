import react from "@vitejs/plugin-react";

export default {
  base: "./",
  plugins: [react()],
  worker: {
    format: "es"
  },
  server: {
    watch: {
      // Build outputs and scratch files; watching them causes reload storms while
      // electron-builder writes release artifacts.
      ignored: ["**/release/**", "**/dist/**", "**/.tmp/**", "**/node_modules/**"]
    }
  }
};
