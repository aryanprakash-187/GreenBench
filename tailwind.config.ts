import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Earth-toned palette — green + blue + warm earth neutrals
        moss: {
          50: "#f2f5ef",
          100: "#e2ead9",
          200: "#c5d5b3",
          300: "#a3b88a",
          400: "#819865",
          500: "#637a4a",
          600: "#4b6038",
          700: "#3a4a2d",
          800: "#2f3a26",
          900: "#1e2618",
        },
        forest: {
          500: "#3A5A40",
          600: "#2f4a34",
          700: "#253a2a",
          800: "#1b2c20",
          900: "#111e16",
        },
        ocean: {
          100: "#d7e3ec",
          200: "#b0c7d8",
          300: "#82a7bf",
          400: "#5d8aa8",
          500: "#3f6e8f",
          600: "#335a75",
          700: "#284659",
          800: "#1d3241",
          900: "#131f29",
        },
        sand: {
          50: "#faf5ec",
          100: "#f3ead7",
          200: "#e6d7b8",
          300: "#d7bf94",
          400: "#c3a572",
          500: "#a98b57",
        },
        clay: {
          400: "#a67753",
          500: "#8a5d3c",
          600: "#6e4a2f",
          700: "#523624",
        },
      },
      fontFamily: {
        display: [
          "Fraunces",
          "Playfair Display",
          "Georgia",
          "ui-serif",
          "serif",
        ],
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "sans-serif",
        ],
        brand: [
          "Cormorant",
          "Cormorant Garamond",
          "Garamond",
          "Georgia",
          "ui-serif",
          "serif",
        ],
      },
      boxShadow: {
        soft: "0 10px 30px -12px rgba(17, 30, 22, 0.35)",
      },
      backgroundImage: {
        "earth-hero":
          "radial-gradient(ellipse at 20% 10%, rgba(93,138,168,0.35), transparent 55%), radial-gradient(ellipse at 80% 90%, rgba(75,96,56,0.55), transparent 55%), linear-gradient(180deg, #1b2c20 0%, #253a2a 55%, #284659 100%)",
        "earth-home":
          "radial-gradient(ellipse at 80% 0%, rgba(130,167,191,0.25), transparent 55%), linear-gradient(180deg, #f3ead7 0%, #e6d7b8 100%)",
      },
    },
  },
  plugins: [],
};

export default config;
