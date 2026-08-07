import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // TYRION core surfaces (existing semantic tokens, remapped)
        background: "#15171C",
        elevated: "#1D2027",
        card: "#23272F",
        "card-2": "#2A2F38",
        border: "#2A2F38",
        hair: "#22262E",
        muted: "#A9A293",
        dim: "#6E6A60",
        foreground: "#ECE7D9",
        parchment: "#F3ECDD",
        // Brand — gold is brand-only, never a status
        accent: "#C9A24A",
        gold: "#C9A24A",
        "gold-hi": "#E6C260",
        "gold-deep": "#8A6B27",
        oxblood: "#6A2233",
        // Status
        success: "#2FB170",
        warning: "#E7A13A",
        error: "#D2453D",
        info: "#4F8FF7",
        // Kids
        jake: "#4F8FA8",
        emma: "#8A6FB0",
        sophie: "#7FA66A",
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', "system-ui", "sans-serif"],
        serif: ['"Cormorant Garamond"', "Georgia", "serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "monospace"],
      },
      keyframes: {
        "slide-out": {
          "0%": { opacity: "1", transform: "translateX(0)" },
          "100%": { opacity: "0", transform: "translateX(100%)" },
        },
        "fade-in": {
          "0%": { opacity: "0", transform: "translateY(-4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "slide-out": "slide-out 0.3s ease-out forwards",
        "fade-in": "fade-in 0.2s ease-out",
      },
    },
  },
  plugins: [],
};
export default config;
