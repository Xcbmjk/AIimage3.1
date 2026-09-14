@echo off
title AIAimage Services Launcher
echo ============================================
echo   Starting AIAimage services (3 windows)
echo ============================================
echo.
echo [1/3] Starting API on port 8787...
start "AIAimage-API" /min cmd /c "cd /d C:\aiaimage && C:\aiaimage\.venv\Scripts\python.exe -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8787 --reload"
echo [2/3] Starting Web on port 5173...
start "AIAimage-Web" /min cmd /c "cd /d C:\aiaimage && C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-3\node.exe node_modules\vite\bin\vite.js"
echo [3/3] Starting frpc tunnel...
start "AIAimage-frpc" /min cmd /c "cd /d D:\SOFT\frp_0.67.0_windows_amd64 && D:\SOFT\frp_0.67.0_windows_amd64\frpc.exe -c frpc.toml"
echo.
echo All 3 services started in minimized windows.
echo DO NOT close those windows - closing one stops that service.
echo.
echo Local API:   http://127.0.0.1:8787
echo Local Web:   http://127.0.0.1:5173
echo Public URL:  http://141.11.148.184:8080
echo.
pause
