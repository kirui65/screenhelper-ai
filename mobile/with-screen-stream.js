const { withAndroidManifest } = require("expo/config-plugins");

const CAPTURE_SERVICE = "expo.modules.screenstream.ScreenProjectionService";
const REQUIRED_PERMISSIONS = [
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION",
];

module.exports = function withScreenStream(config) {
  return withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    const application = manifest.application?.[0];
    if (!application) return mod;

    application.$ = application.$ || {};
    application.$["android:resizeableActivity"] = "true";
    manifest["uses-permission"] = manifest["uses-permission"] || [];
    for (const permission of REQUIRED_PERMISSIONS) {
      if (!manifest["uses-permission"].some((entry) => entry.$?.["android:name"] === permission)) {
        manifest["uses-permission"].push({ $: { "android:name": permission } });
      }
    }
    application.service = application.service || [];
    if (!application.service.some((entry) => entry.$?.["android:name"] === CAPTURE_SERVICE)) {
      application.service.push({
        $: {
          "android:name": CAPTURE_SERVICE,
          "android:exported": "false",
          "android:foregroundServiceType": "mediaProjection",
        },
      });
    }
    return mod;
  });
};
