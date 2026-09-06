# Q Tracker

Desktop productivity / tracker app built with **Tauri + React + Supabase**.

## Stack
- Tauri 2 (desktop shell, optional autostart)
- React + TypeScript + Vite
- Supabase (schema deploy script included)
- Tailwind CSS

## Run locally
```bash
npm install
npm run dev          # web UI
npm run tauri dev    # desktop app
```

## Notes
Keep Supabase credentials in local env / Tauri config — do not commit secrets.
