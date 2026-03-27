/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./extension/popup/**/*.{html,js}", "./extension/options/**/*.{html,js}"],
  theme: {
    extend: {
      colors: {
        primary: '#FFD32C',
      },
    },
  },
  plugins: [],
}
