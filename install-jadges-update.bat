@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Jadges Updater

echo.
echo ========================================
echo        Jadges Windows Updater
echo ========================================
echo.

call :find_vencord
if not defined VENCORD_ROOT (
    echo [ERROR] Could not find your Vencord source folder.
    echo Put Vencord at %%USERPROFILE%%\Vencord or set VENCORD_ROOT.
    echo.
    pause
    exit /b 1
)

echo [1/6] Found Vencord at:
echo       %VENCORD_ROOT%

set "USERPLUGINS=%VENCORD_ROOT%\src\userplugins"
set "PLUGIN=%USERPLUGINS%\jadgesBadges"
set "STAMP=%RANDOM%%RANDOM%%RANDOM%"
set "WORK=%TEMP%\jadges-update-%STAMP%"
set "ZIP=%WORK%\Jadges-main.zip"
set "EXTRACT=%WORK%\extracted"
set "SOURCE=%EXTRACT%\Jadges-main\vencord-plugin\jadgesBadges"
set "BACKUP=%USERPLUGINS%\.jadgesBadges-backup-%STAMP%"
set "JADGES_ZIP=%ZIP%"
set "JADGES_EXTRACT=%EXTRACT%"

mkdir "%WORK%" >nul 2>&1
if errorlevel 1 goto :work_failed

echo [2/6] Downloading the Jadges repository ZIP...
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/thatcodingdude23/Jadges/archive/refs/heads/main.zip' -OutFile $env:JADGES_ZIP"
if errorlevel 1 goto :download_failed

echo [3/6] Extracting the Jadges plugin...
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath $env:JADGES_ZIP -DestinationPath $env:JADGES_EXTRACT -Force"
if errorlevel 1 goto :extract_failed

for %%F in (index.tsx base.tsx native.ts style.css updater.ts updateNative.ts) do (
    if not exist "%SOURCE%\%%F" (
        echo [ERROR] The repository ZIP is missing %%F.
        goto :clean_failure
    )
)

echo [4/6] Replacing the old userplugins\jadgesBadges folder...
if exist "%BACKUP%" rmdir /s /q "%BACKUP%"
if exist "%PLUGIN%" (
    move /y "%PLUGIN%" "%BACKUP%" >nul
    if errorlevel 1 goto :backup_failed
)

robocopy "%SOURCE%" "%PLUGIN%" /E /NFL /NDL /NJH /NJS /NP >nul
set "COPY_RC=!ERRORLEVEL!"
if !COPY_RC! GEQ 8 goto :copy_failed

echo [5/6] Running pnpm build...
pushd "%VENCORD_ROOT%"
call pnpm.cmd build
set "BUILD_RC=!ERRORLEVEL!"
if "!BUILD_RC!"=="9009" (
    echo pnpm.cmd was not found. Trying Corepack...
    call corepack.cmd pnpm build
    set "BUILD_RC=!ERRORLEVEL!"
)
popd
if not "!BUILD_RC!"=="0" goto :build_failed

echo [6/6] Cleaning up and restarting Discord...
if exist "%BACKUP%" rmdir /s /q "%BACKUP%"
if exist "%WORK%" rmdir /s /q "%WORK%"
call :restart_discord

echo.
echo [SUCCESS] Jadges was updated and Vencord was rebuilt.
echo Discord is restarting now.
timeout /t 3 /nobreak >nul
exit /b 0

:find_vencord
if defined VENCORD_ROOT (
    if exist "%VENCORD_ROOT%\package.json" (
        if exist "%VENCORD_ROOT%\src\userplugins" goto :eof
    )
)
set "VENCORD_ROOT="
for %%D in (
    "%USERPROFILE%\Vencord"
    "%USERPROFILE%\vencord"
    "%USERPROFILE%\Desktop\Vencord"
    "%USERPROFILE%\Documents\Vencord"
    "%USERPROFILE%\Downloads\Vencord"
) do (
    if not defined VENCORD_ROOT (
        if exist "%%~fD\package.json" (
            if exist "%%~fD\src\userplugins" set "VENCORD_ROOT=%%~fD"
        )
    )
)
goto :eof

:restart_discord
set "DISCORD_FOLDER=Discord"
set "DISCORD_EXE=Discord.exe"
tasklist /FI "IMAGENAME eq DiscordCanary.exe" 2>nul | find /I "DiscordCanary.exe" >nul && (
    set "DISCORD_FOLDER=DiscordCanary"
    set "DISCORD_EXE=DiscordCanary.exe"
)
tasklist /FI "IMAGENAME eq DiscordPTB.exe" 2>nul | find /I "DiscordPTB.exe" >nul && (
    set "DISCORD_FOLDER=DiscordPTB"
    set "DISCORD_EXE=DiscordPTB.exe"
)
tasklist /FI "IMAGENAME eq Discord.exe" 2>nul | find /I "Discord.exe" >nul && (
    set "DISCORD_FOLDER=Discord"
    set "DISCORD_EXE=Discord.exe"
)
taskkill /F /IM "!DISCORD_EXE!" >nul 2>&1
timeout /t 2 /nobreak >nul
if exist "%LOCALAPPDATA%\!DISCORD_FOLDER!\Update.exe" (
    start "" "%LOCALAPPDATA%\!DISCORD_FOLDER!\Update.exe" --processStart "!DISCORD_EXE!"
) else (
    echo [WARNING] Discord was closed, but its Update.exe was not found.
    echo Open Discord normally from the Start menu.
)
goto :eof

:work_failed
echo [ERROR] Could not create the temporary update folder.
goto :failure_pause

:download_failed
echo [ERROR] The Jadges repository ZIP could not be downloaded.
goto :clean_failure

:extract_failed
echo [ERROR] The Jadges repository ZIP could not be extracted.
goto :clean_failure

:backup_failed
echo [ERROR] The old Jadges folder could not be backed up.
goto :clean_failure

:copy_failed
echo [ERROR] The new Jadges folder could not be copied.
goto :rollback

:build_failed
echo.
echo [ERROR] pnpm build failed with exit code !BUILD_RC!.
goto :rollback

:rollback
echo Restoring the previous Jadges plugin...
if exist "%PLUGIN%" rmdir /s /q "%PLUGIN%"
if exist "%BACKUP%" move /y "%BACKUP%" "%PLUGIN%" >nul
pushd "%VENCORD_ROOT%"
call pnpm.cmd build >nul 2>&1
if errorlevel 9009 call corepack.cmd pnpm build >nul 2>&1
popd
goto :clean_failure

:clean_failure
if exist "%WORK%" rmdir /s /q "%WORK%"

:failure_pause
echo.
echo The update was not installed. Your previous plugin was kept or restored.
pause
exit /b 1
