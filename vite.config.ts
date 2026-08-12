import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "./",
  plugins: [
    {
      name: "katex-woff2-only",
      enforce: "pre",
      transform(source, id) {
        if (!id.includes("/katex/dist/katex.min.css")) return null;
        return source.replace(
          /src:url\(([^)]+\.woff2)\) format\("woff2"\),url\([^)]+\.woff\) format\("woff"\),url\([^)]+\.ttf\) format\("truetype"\)/g,
          'src:url($1) format("woff2")'
        );
      }
    }
  ],
  test: {
    environment: "jsdom",
    include: ["src/test/**/*.test.ts"]
  }
});
