@echo off
title TeoGlobal — Servidor de Licencas
cd /d "%~dp0"

set LICENSE_SECRET=rI0KPMDj6yk3OXSzLmYxs74fqbTaicB8NH9AWRvJtlgFGwVQ
set DASHBOARD_PASSWORD=85344rp.
set PORT=3001

echo.
echo ========================================================
echo   TeoGlobal — Dashboard de Licencas
echo ========================================================
echo.
echo   Abra: http://localhost:3001/admin
echo   Senha: 85344rp.
echo.

start "" http://localhost:3001/admin

node server.js
pause
