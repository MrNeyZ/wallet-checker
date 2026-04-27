import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./ui-kit/**/*.{ts,tsx}",
  ],
  darkMode: "class",
  theme: { extend: {} },
  plugins: [],
};

export default config;
