/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{vue,js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Prompt', 'sans-serif'],
      },
      colors: {
        primary: {
          900: '#0a1628',
          800: '#0f2440',
          700: '#1e3a5f',
          600: '#2d4a6f',
          500: '#3d5a80',
          400: '#5a7a9a',
          DEFAULT: '#1e3a5f',
        },
        gray: {
          50: '#f8fafc',
          100: '#f1f5f9',
          200: '#e2e8f0',
          300: '#cbd5e1',
          400: '#94a3b8',
          500: '#64748b',
          600: '#475569',
          700: '#334155',
        }
      },
      borderRadius: {
        'sm': '4px',
        'md': '6px',
        'lg': '8px',
        'xl': '10px',
        '2xl': '12px',
        '3xl': '16px',
      },
      boxShadow: {
        'xs': '0 1px 2px rgba(30,58,95,0.04)',
        'sm': '0 1px 3px rgba(30,58,95,0.06)',
        'md': '0 2px 8px rgba(30,58,95,0.08)',
        'lg': '0 4px 16px rgba(30,58,95,0.10)',
        'xl': '0 8px 24px rgba(30,58,95,0.12)',
        '2xl': '0 12px 32px rgba(30,58,95,0.16)',
      },
      spacing: {
        '70': '280px',
      }
    },
  },
  plugins: [
    require('daisyui'),
  ],
  daisyui: {
    themes: [
      {
        painface: {
          "primary": "#1e3a5f",
          "primary-focus": "#2d4a6f",
          "primary-content": "#ffffff",

          "secondary": "#3d5a80",
          "secondary-focus": "#2d4a6f",
          "secondary-content": "#ffffff",

          "accent": "#5a7a9a",
          "accent-focus": "#3d5a80",
          "accent-content": "#ffffff",

          "neutral": "#334155",
          "neutral-focus": "#1e293b",
          "neutral-content": "#ffffff",

          "base-100": "#ffffff",
          "base-200": "#f8fafc",
          "base-300": "#f1f5f9",
          "base-content": "#1e3a5f",

          "info": "#3b82f6",
          "info-content": "#ffffff",

          "success": "#16a34a",
          "success-content": "#ffffff",

          "warning": "#f59e0b",
          "warning-content": "#ffffff",

          "error": "#dc2626",
          "error-content": "#ffffff",

          "--rounded-box": "12px",
          "--rounded-btn": "6px",
          "--rounded-badge": "4px",
          "--animation-btn": "0.2s",
          "--animation-input": "0.2s",
          "--btn-focus-scale": "0.98",
          "--border-btn": "1px",
          "--tab-border": "1px",
          "--tab-radius": "6px",
        },
      },
    ],
    darkTheme: false,
    base: true,
    styled: true,
    utils: true,
    prefix: "",
    logs: false,
    themeRoot: ":root",
  },
}
