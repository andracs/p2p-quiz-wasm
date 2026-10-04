import { defineConfig } from "vite";

export default defineConfig({
  // Relative URLs, so the build works under https://<user>.github.io/<repo>/.
  base: "./",
  build: { target: "es2022" },
});
