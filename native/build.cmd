@echo off
rem Builds the native bridge: core tests (console) and the AEGP plug-in (.aex).
rem Usage: build.cmd [AE_SDK_EXAMPLES_DIR] or set AE_SDK_EXAMPLES_DIR.
setlocal
set "HERE=%~dp0"
set "SDK=%~1"
if "%SDK%"=="" set "SDK=%AE_SDK_EXAMPLES_DIR%"
if "%SDK%"=="" ( echo Pass the After Effects SDK Examples directory or set AE_SDK_EXAMPLES_DIR & exit /b 1 )
set "OUT=%HERE%out"
set "OBJ=%OUT%\obj"
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
for /f "usebackq delims=" %%i in (`call "%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VS=%%i"
if not defined VS ( echo Visual Studio C++ tools not found & exit /b 1 )
call "%VS%\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
if not exist "%OBJ%" mkdir "%OBJ%"

set CFLAGS=/nologo /std:c++17 /EHsc /W3 /O2 /MD /utf-8 /DWIN32 /D_WINDOWS /DUNICODE /D_UNICODE
set CORE="%HERE%core\Json.cpp" "%HERE%core\Files.cpp" "%HERE%core\BridgeCore.cpp" "%HERE%core\ScriptText.cpp"

echo [1/3] core tests
cl %CFLAGS% /Fo"%OBJ%\\" /Fe"%OUT%\CoreTests.exe" "%HERE%test\CoreTests.cpp" %CORE% shell32.lib || exit /b 1
"%OUT%\CoreTests.exe" || exit /b 1
rem The exact ExtendScript sent to AE, run against the real function runtime with an ExtendScript shim.
cl %CFLAGS% /Fo"%OBJ%\\" /Fe"%OUT%\ScriptDump.exe" "%HERE%test\ScriptDump.cpp" "%HERE%core\Json.cpp" "%HERE%core\ScriptText.cpp" || exit /b 1
node "%HERE%test\script-harness.cjs" "%OUT%\ScriptDump.exe" "%HERE%..\engine" || exit /b 1

echo [2/3] PiPL resource
cl /nologo /I "%SDK%\Headers" /EP "%HERE%plugin\AECT_PiPL.r" > "%OBJ%\AECT_PiPL.rr" || exit /b 1
"%SDK%\Resources\PiPLTool.exe" "%OBJ%\AECT_PiPL.rr" "%OBJ%\AECT_PiPL.rrc" || exit /b 1
cl /nologo /D "MSWindows" /EP "%OBJ%\AECT_PiPL.rrc" > "%OBJ%\AECT_PiPL.rc" || exit /b 1
rc /nologo /fo "%OBJ%\AECT_PiPL.res" "%OBJ%\AECT_PiPL.rc" || exit /b 1

echo [3/3] AEGP plug-in
set INC=/I "%SDK%\Headers" /I "%SDK%\Headers\SP" /I "%SDK%\Headers\Win" /I "%SDK%\Resources" /I "%SDK%\Util" /I "%HERE%plugin"
rem The AE SDK headers are ANSI (char) based: build the plug-in without UNICODE.
rem /MT: static C++ runtime, so the .aex does not depend on a VC++ redistributable being installed.
set PFLAGS=/nologo /std:c++17 /EHsc /W3 /O2 /MT /utf-8 /DMSWindows /DWIN32 /D_WINDOWS
cl %PFLAGS% %INC% /LD /Fo"%OBJ%\\" /Fe"%OUT%\AE_CodexTeam_Native.aex" ^
  "%HERE%plugin\AECT_Native.cpp" "%HERE%plugin\ScriptExecutor.cpp" "%HERE%plugin\NativePanel.cpp" ^
  %CORE% "%SDK%\Util\AEGP_SuiteHandler.cpp" "%SDK%\Util\MissingSuiteError.cpp" "%OBJ%\AECT_PiPL.res" ^
  user32.lib gdi32.lib /link /DLL || exit /b 1
echo Built %OUT%\AE_CodexTeam_Native.aex
endlocal
