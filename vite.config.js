import react from "@vitejs/plugin-react";

export default {
  plugins: [react()],
  worker: {
    format: "es"
  }
};
