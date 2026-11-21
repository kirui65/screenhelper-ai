package expo.modules.screenstream

import android.content.Intent
import android.os.Build
import expo.modules.kotlin.activityresult.AppContextActivityResultLauncher
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.Base64

class ScreenStreamModule : Module() {
  private lateinit var consentLauncher: AppContextActivityResultLauncher<ScreenCaptureRequest, ScreenCaptureResult>

  override fun definition() = ModuleDefinition {
    Name("ScreenStream")

    RegisterActivityContracts {
      consentLauncher = registerForActivityResult(ScreenCaptureContract())
    }

    AsyncFunction("start").SuspendBody<Boolean> {
      if (appContext.currentActivity == null) {
        throw IllegalStateException("Open ScreenHelper before starting screen sharing.")
      }
      if (!ScreenProjectionService.isActive) {
        val result = consentLauncher.launch(ScreenCaptureRequest.START)
        if (result.resultCode != android.app.Activity.RESULT_OK || result.data == null) {
          throw IllegalStateException("Screen sharing permission was not granted.")
        }
        val context = appContext.reactContext
          ?: throw IllegalStateException("Screen sharing is unavailable right now.")
        val serviceIntent = Intent(context, ScreenProjectionService::class.java).apply {
          action = ScreenProjectionService.ACTION_START
          putExtra(ScreenProjectionService.EXTRA_RESULT_CODE, result.resultCode)
          putExtra(ScreenProjectionService.EXTRA_RESULT_DATA, result.data)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(serviceIntent)
        else context.startService(serviceIntent)
      }
      true
    }

    AsyncFunction("stop") {
      appContext.reactContext?.let { context ->
        context.startService(Intent(context, ScreenProjectionService::class.java).apply {
          action = ScreenProjectionService.ACTION_STOP
        })
      }
      true
    }

    AsyncFunction("isActive") {
      ScreenProjectionService.isActive
    }

    AsyncFunction("captureFrame") {
      if (!ScreenProjectionService.isActive) {
        throw IllegalStateException("Screen sharing is no longer active. Start it again before capturing.")
      }
      val frame = ScreenProjectionService.latestFrame
        ?: throw IllegalStateException("No shared screen frame is ready. Wait a moment and capture again.")
      if (System.currentTimeMillis() - ScreenProjectionService.latestFrameAt > 4000L) {
        throw IllegalStateException("The shared screen frame is out of date. Capture again.")
      }
      "data:image/jpeg;base64,${Base64.getEncoder().encodeToString(frame)}"
    }
  }
}
