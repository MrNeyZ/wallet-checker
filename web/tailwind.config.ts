import type { Config } from "tailwindcss";

// VictoryLabs palette is exposed both as CSS custom properties (in
// app/globals.css) AND as Tailwind utilities here so you can pick whichever
// fits a given surface: `bg-vl-bg`, `text-vl-fg-2`, `border-vl-border`,
// `text-vl-purple`, etc. Existing Tailwind neutrals/emeralds are untouched
// — this is a pure extension, no overrides.
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./ui-kit/**/*.{ts,tsx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        vl: {
          bg: "#07060e",
          "bg-2": "#0d0b1a",
          page: "#1a162e",
          surface: "#231e3d",
          "surface-2": "#2c2649",
          border: "rgba(168,144,232,0.30)",
          "border-h": "rgba(168,144,232,0.50)",
          fg: "#f2eeff",
          "fg-2": "#a59fc4",
          "fg-3": "#7a7497",
          "fg-4": "#524d6e",
          purple: "#a890e8",
          "purple-2": "#d0c8e4",
          "purple-soft": "rgba(168,144,232,0.14)",
          "purple-border": "rgba(168,144,232,0.40)",
          green: "#4fb67d",
          red: "#ef7878",
          amber: "#fbbf24",
        },
      },
      fontFamily: {
        "vl-mono": [
          "Fira Code",
          "SF Mono",
          "ui-monospace",
          "monospace",
        ],
        "vl-serif": ["Playfair Display", "Georgia", "serif"],
      },
    },
  },
  plugins: [],
};

export default config;
