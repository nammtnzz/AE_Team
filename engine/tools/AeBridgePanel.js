#target aftereffects
#targetengine "aeCodexTeamBridge"
/* Thin user-profile panel: the reviewed runtime stays in the installation. */
(function (thisObject) {
    var bundle, errorText;
    var keys = ["__AECT_WORKSPACE_ROOT__", "__AECT_PANEL_HOST__", "__AECT_AUTOSTART_ONLY__"];
    var previous = [], present = [], index;
    for (index = 0; index < keys.length; index += 1) {
        present[index] = Object.prototype.hasOwnProperty.call($.global, keys[index]);
        previous[index] = $.global[keys[index]];
    }
    try {
        bundle = new File(__AECT_WORKSPACE_BUNDLE__);
        if (!bundle.exists) { throw new Error("Workspace bundle is missing: " + bundle.fsName); }
        if (bundle.alias || bundle.parent.alias) { throw new Error("Workspace bundle is aliased: " + bundle.fsName); }
        $.global.__AECT_WORKSPACE_ROOT__ = bundle.parent.parent.fsName;
        $.global.__AECT_PANEL_HOST__ = thisObject;
        $.global.__AECT_AUTOSTART_ONLY__ = false;
        $.evalFile(bundle);
    } catch (error) {
        errorText = "Codex AE: " + error.toString() +
            (error.line ? "\nDòng: " + error.line : "") +
            (error.fileName ? "\nTệp: " + error.fileName : "") +
            "\nMở Codex AE để sửa bản cài đặt.";
        try { $.writeln(errorText); } catch (ignoredLogError) {}
        try {
            if (thisObject instanceof Panel) {
                thisObject.add("statictext", undefined, errorText, { multiline: true });
                thisObject.layout.layout(true);
            }
        } catch (ignoredUiError) {}
    } finally {
        for (index = 0; index < keys.length; index += 1) {
            if (present[index]) { $.global[keys[index]] = previous[index]; }
            else { delete $.global[keys[index]]; }
        }
    }
}(this));
