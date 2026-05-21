import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './src/renderer/index.html',
    './src/renderer/src/**/*.{js,ts,jsx,tsx}'
  ],
  theme: {
    extend: {
      colors: {
        may: {
          bg: '#0a0a0a',
          surface: '#121212',
          primary: '#00e5ff',
          secondary: '#7000ff',
          accent: '#ff007a',
          text: '#e0e0e0',
          muted: '#808080'
        }
      }
    }
  },
  plugins: []
}

export default config
