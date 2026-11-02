/* Included inside the reusable-function runtime IIFE; ES3, no separate JSX. */
    function extraLayerSelectors(value, path, refs, allowEmpty) {
        var i;
        if (!array(value) || value.length > 1000 || (!allowEmpty && !value.length)) { fail(path + " must contain " + (allowEmpty ? "0" : "1") + " to 1000 layer selectors"); }
        for (i = 0; i < value.length; i += 1) { selector(value[i], path + "[" + i + "]", "layer", refs); }
    }
    function extraResolveLayers(comp, selections, refs, entry) {
        var layers = [], i, j, layer;
        for (i = 0; i < selections.length; i += 1) {
            layer = entry && entry.layers && entry.layers[i] ? entry.layers[i] : resolveLayer(comp, selections[i], refs);
            if (layer.containingComp !== comp) { fail("Selected layer no longer belongs to the selected composition: " + layer.name); }
            for (j = 0; j < layers.length; j += 1) { if (layers[j] === layer) { fail("The same layer was selected more than once: " + layer.name); } }
            layers.push(layer);
        }
        return layers;
    }
    function extraUnlocked(layer, operation) {
        if (!layer || !layer.containingComp || !integer(layer.index) || layer.index < 1) { fail("Layer is no longer available for " + operation); }
        if (layer.locked) { fail("Layer is locked; unlock it explicitly before " + operation + ": " + layer.name); }
    }
    function extraLayerCreationCheck(args, refs) {
        selectors(args, refs, false);
        optional(args, "name", function (value, path) { text(value, path, 1024); });
        optional(args, "position", function (value, path) { vector(value, path, 2, 2); });
    }
    register("team.comp.duplicate", "Duplicate a composition, preserving its layer sources; optional step.as creates a comp reference", true,
        { comp: "optional comp selector", name: "optional duplicate composition name" },
        function (args, refs) { selectors(args, refs, false); optional(args, "name", function (value, path) { text(value, path, 1024); }); },
        function (args, refs, entry) {
            var comp = resolved(args, refs, entry, false).comp, duplicate;
            if (typeof comp.duplicate !== "function") { fail("Composition duplication is unavailable"); }
            duplicate = comp.duplicate();
            if (!isComp(duplicate)) { fail("After Effects did not return a duplicated composition"); }
            if (has(args, "name")) { duplicate.name = args.name; }
            return { value: compSummary(duplicate), reference: duplicate };
        }, "comp");
    register("team.comp.precompose", "Move selected layers into a new precomposition; optional step.as creates a comp reference", true,
        { comp: "optional comp selector", layers: "1..1000 unique layer selectors", name: "new precomposition name", moveAttributes: "optional boolean; default true; false requires exactly one layer" },
        function (args, refs) {
            selectors(args, refs, false); extraLayerSelectors(args.layers, "args.layers", refs, false); text(args.name, "args.name", 1024); optional(args, "moveAttributes", boolValue);
            if (args.moveAttributes === false && args.layers.length !== 1) { fail("moveAttributes:false requires exactly one layer"); }
        },
        function (args, refs, entry) {
            var comp = resolved(args, refs, entry, false).comp, layers = extraResolveLayers(comp, args.layers, refs, entry), indices = [], i, precomp;
            if (!comp.layers || typeof comp.layers.precompose !== "function") { fail("Composition precompose is unavailable"); }
            for (i = 0; i < layers.length; i += 1) { extraUnlocked(layers[i], "precomposing"); indices.push(layers[i].index); }
            indices.sort(function (left, right) { return left - right; });
            precomp = comp.layers.precompose(indices, args.name, args.moveAttributes !== false);
            if (!isComp(precomp)) { fail("After Effects did not return a precomposition"); }
            return { value: compSummary(precomp), reference: precomp };
        }, "comp");
    register("team.layer.camera.create", "Create a camera using a 2D creation center; configure zoom and one-node/two-node orientation", true,
        { comp: "optional comp selector", name: "optional camera name; default Camera", position: "optional [x,y] creation center; default composition center", type: "optional one-node or two-node; default two-node", zoom: "optional camera zoom >= 0.001 and <= 10000000" },
        function (args, refs) {
            extraLayerCreationCheck(args, refs);
            if (has(args, "type") && args.type !== "one-node" && args.type !== "two-node") { fail("args.type must be one-node or two-node"); }
            optional(args, "zoom", function (value, path) { number(value, path, 0.001, 10000000); });
        },
        function (args, refs, entry) {
            var comp = resolved(args, refs, entry, false).comp, orientation, layer, zoom;
            if (!comp.layers || typeof comp.layers.addCamera !== "function") { fail("Camera creation is unavailable"); }
            if (typeof AutoOrientType === "undefined") { fail("Camera orientation constants are unavailable"); }
            orientation = args.type === "one-node" ? AutoOrientType.NO_AUTO_ORIENT : AutoOrientType.CAMERA_OR_POINT_OF_INTEREST;
            if (typeof orientation === "undefined") { fail("Requested camera orientation is unavailable"); }
            layer = comp.layers.addCamera(args.name || "Camera", args.position || [comp.width / 2, comp.height / 2]);
            layer.autoOrient = orientation;
            if (has(args, "zoom")) { zoom = resolveProperty(layer, ["ADBE Camera Options Group", "ADBE Camera Zoom"]); writeValue(zoom, args.zoom); }
            return { value: layerSummary(layer), reference: layer };
        }, "layer");
    register("team.layer.light.create", "Create a light with an explicit type, 2D creation center and optional color/intensity", true,
        { comp: "optional comp selector", name: "optional light name; default Light", type: "optional point, spot, parallel or ambient; default point", position: "optional [x,y] creation center; default composition center", color: "optional RGB [0..1,0..1,0..1]", intensity: "optional number 0..100000" },
        function (args, refs) {
            extraLayerCreationCheck(args, refs);
            if (has(args, "type") && args.type !== "point" && args.type !== "spot" && args.type !== "parallel" && args.type !== "ambient") { fail("args.type must be point, spot, parallel or ambient"); }
            optional(args, "color", function (value, path) { vector(value, path, 3, 3, 0, 1); }); optional(args, "intensity", function (value, path) { number(value, path, 0, 100000); });
        },
        function (args, refs, entry) {
            var comp = resolved(args, refs, entry, false).comp, kind = args.type || "point", type, layer;
            if (!comp.layers || typeof comp.layers.addLight !== "function") { fail("Light creation is unavailable"); }
            if (typeof LightType === "undefined") { fail("Light type constants are unavailable"); }
            type = kind === "spot" ? LightType.SPOT : (kind === "parallel" ? LightType.PARALLEL : (kind === "ambient" ? LightType.AMBIENT : LightType.POINT));
            if (typeof type === "undefined") { fail("Requested light type is unavailable"); }
            layer = comp.layers.addLight(args.name || "Light", args.position || [comp.width / 2, comp.height / 2]); layer.lightType = type;
            if (has(args, "color")) { writeValue(resolveProperty(layer, ["ADBE Light Options Group", "ADBE Light Color"]), args.color); }
            if (has(args, "intensity")) { writeValue(resolveProperty(layer, ["ADBE Light Options Group", "ADBE Light Intensity"]), args.intensity); }
            return { value: layerSummary(layer), reference: layer };
        }, "layer");
    register("team.layer.remove", "Remove exactly the selected unlocked layer", true,
        { comp: "optional comp selector", layer: "layer selector" },
        function (args, refs) { selectors(args, refs, true); },
        function (args, refs, entry) {
            var layer = resolved(args, refs, entry, true).layer, summary;
            extraUnlocked(layer, "removing"); if (typeof layer.remove !== "function") { fail("Selected layer cannot be removed"); }
            summary = layerSummary(layer); layer.remove(); return { removed: summary };
        });
    register("team.layer.select", "Select exact layers; replace defaults true, and an empty list clears the selection", true,
        { comp: "optional comp selector", layers: "0..1000 unique unlocked layer selectors", replace: "optional boolean; default true" },
        function (args, refs) { selectors(args, refs, false); extraLayerSelectors(args.layers, "args.layers", refs, true); optional(args, "replace", boolValue); },
        function (args, refs, entry) {
            var comp = resolved(args, refs, entry, false).comp, layers = extraResolveLayers(comp, args.layers, refs, entry), i, selected = [];
            for (i = 0; i < layers.length; i += 1) { extraUnlocked(layers[i], "selecting"); }
            if (args.replace !== false) { for (i = 1; i <= comp.numLayers; i += 1) { comp.layer(i).selected = false; } }
            for (i = 0; i < layers.length; i += 1) { layers[i].selected = true; }
            for (i = 1; i <= comp.numLayers; i += 1) { if (comp.layer(i).selected) { selected.push(layerSummary(comp.layer(i))); } }
            return { compId: comp.id, selected: selected };
        });
    var extraBlendModes = { Normal: "NORMAL", Add: "ADD", Multiply: "MULTIPLY", Screen: "SCREEN", Overlay: "OVERLAY", SoftLight: "SOFT_LIGHT", HardLight: "HARD_LIGHT", ColorDodge: "COLOR_DODGE", ColorBurn: "COLOR_BURN", Difference: "DIFFERENCE", Exclusion: "EXCLUSION", Hue: "HUE", Saturation: "SATURATION", Color: "COLOR", Luminosity: "LUMINOSITY", Darken: "DARKEN", Lighten: "LIGHTEN" };
    register("team.layer.blendMode", "Set an AV layer's actual blendingMode using a supported mode name", true,
        { comp: "optional comp selector", layer: "layer selector", mode: "Normal, Add, Multiply, Screen, Overlay, SoftLight, HardLight, ColorDodge, ColorBurn, Difference, Exclusion, Hue, Saturation, Color, Luminosity, Darken or Lighten" },
        function (args, refs) { selectors(args, refs, true); text(args.mode, "args.mode", 32); if (!has(extraBlendModes, args.mode)) { fail("Unsupported blend mode: " + args.mode); } },
        function (args, refs, entry) {
            var layer = resolved(args, refs, entry, true).layer, mode;
            extraUnlocked(layer, "changing blending mode");
            if (typeof layer.blendingMode === "undefined") { fail("Selected layer does not support blending modes"); }
            if (typeof BlendingMode === "undefined") { fail("Blending mode constants are unavailable"); }
            mode = BlendingMode[extraBlendModes[args.mode]]; if (typeof mode === "undefined") { fail("Requested blending mode is unavailable in this host"); }
            layer.blendingMode = mode; return { layer: layerSummary(layer), mode: args.mode };
        });
