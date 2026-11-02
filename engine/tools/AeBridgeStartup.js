#target aftereffects
#targetengine "aeCodexTeamBridge"
/* Installed only in the user's After Effects Scripts/Startup folder. */
(function () {
    var bundle;
    var hadFlag = Object.prototype.hasOwnProperty.call($.global, "__AECT_AUTOSTART_ONLY__");
    var previousFlag = $.global.__AECT_AUTOSTART_ONLY__;
    var hadRoot = Object.prototype.hasOwnProperty.call($.global, "__AECT_WORKSPACE_ROOT__");
    var previousRoot = $.global.__AECT_WORKSPACE_ROOT__;
    try {
        bundle = new File(__AECT_WORKSPACE_BUNDLE__);
        if (!bundle.exists) { throw new Error("Workspace bundle is missing: " + bundle.fsName); }
        if (bundle.alias || bundle.parent.alias) { throw new Error("Workspace bundle is aliased: " + bundle.fsName); }
        $.global.__AECT_AUTOSTART_ONLY__ = true;
        $.global.__AECT_WORKSPACE_ROOT__ = bundle.parent.parent.fsName;
        $.evalFile(bundle);
    } catch (error) {
        try { $.writeln("Codex Bridge startup: " + error.toString()); } catch (ignoredLogError) {}
    } finally {
        if (hadFlag) { $.global.__AECT_AUTOSTART_ONLY__ = previousFlag; }
        else { delete $.global.__AECT_AUTOSTART_ONLY__; }
        if (hadRoot) { $.global.__AECT_WORKSPACE_ROOT__ = previousRoot; }
        else { delete $.global.__AECT_WORKSPACE_ROOT__; }
    }
}());
