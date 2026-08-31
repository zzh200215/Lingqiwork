@echo off
rem Start both backend and frontend dev servers
cd /d "%~dp0backend"
start "workbench-backend" cmd /k "uv run uvicorn app.main:app --reload --port 8000"
cd /d "%~dp0frontend"
start "workbench-frontend" cmd /k "npm run dev"
echo Backend:  http://127.0.0.1:8000
echo Frontend: http://localhost:5173
