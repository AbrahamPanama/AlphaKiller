import react from "@vitejs/plugin-react";

export default {
  base: "./",
  plugins: [react()],
  worker: {
    format: "es"
  }
};
