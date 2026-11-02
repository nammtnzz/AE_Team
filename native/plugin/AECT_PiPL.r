#include "AEConfig.h"

#ifndef AE_OS_WIN
	#include "AE_General.r"
#endif
resource 'PiPL' (16000) {
	{
		Kind {
			AEGP
		},
		Name {
			"AE_CodexTeam Native Bridge"
		},
		Category {
			"General Plugin"
		},
		Version {
			65536
		},
#ifdef AE_OS_WIN
	#if defined(AE_PROC_INTELx64)
		CodeWin64X86 {"EntryPointFunc"},
	#elif defined(AE_PROC_ARM64)
		CodeWinARM64 {"EntryPointFunc"},
	#endif
#endif
	}
};
