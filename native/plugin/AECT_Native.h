// Shared includes for the AE_CodexTeam native bridge AEGP (built from the After Effects SDK headers).
#pragma once
#include "AEConfig.h"
#ifdef AE_OS_WIN
    #include <windows.h>
#endif

#include "entry.h"
#include "AE_GeneralPlug.h"
#include "AE_GeneralPlugPanels.h"
#include "AE_Macros.h"
#include "AEGP_SuiteHandler.h"
#include "SPBasic.h"
#ifndef DEBUG
    #define DEBUG 1
#endif
#include "SimpleSuiteHelper.h"

// Match name / menu text. Distinct from Codex AE ("Codex Bridge") so both can be installed together.
#define AECT_PANEL_MATCH_NAME "AE_CodexTeam Native Bridge"
#define AECT_MENU_TEXT "AE_CodexTeam Native Bridge"

extern "C" DllExport AEGP_PluginInitFuncPrototype EntryPointFunc;
