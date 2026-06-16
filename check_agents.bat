@echo off
chcp 65001 >nul 2>&1
echo ===== ПРОВЕРКА АГЕНТОВ ВЕРТЕР =====
echo.

set OLLAMA=C:\Users\mavrin.an\AppData\Local\Programs\Ollama\ollama.exe

%OLLAMA% show qwen3.5:9b >nul 2>&1 && echo [1] creative: qwen3.5:9b = OK || echo [1] creative: qwen3.5:9b = MISSING
%OLLAMA% show qwen2.5-coder:7b >nul 2>&1 && echo [2] designer: qwen2.5-coder:7b = OK || echo [2] designer: qwen2.5-coder:7b = MISSING
%OLLAMA% show qwen2.5-coder:7b >nul 2>&1 && echo [3] frontend: qwen2.5-coder:7b = OK || echo [3] frontend: qwen2.5-coder:7b = MISSING
%OLLAMA% show llama3:8b >nul 2>&1 && echo [4] editor: llama3:8b = OK || echo [4] editor: llama3:8b = MISSING
%OLLAMA% show deepseek-r1:8b >nul 2>&1 && echo [5] critic: deepseek-r1:8b = OK || echo [5] critic: deepseek-r1:8b = MISSING

echo.
"C:\Program Files\nodejs\node.exe" --check orchestrator.js >nul 2>&1 && echo orchestrator.js: OK || echo orchestrator.js: SYNTAX ERROR
echo.
echo ===== =====
