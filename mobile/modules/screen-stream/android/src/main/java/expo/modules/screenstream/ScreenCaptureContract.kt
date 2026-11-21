package expo.modules.screenstream

import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import expo.modules.kotlin.activityresult.AppContextActivityResultContract
import java.io.Serializable

enum class ScreenCaptureRequest : Serializable {
  START,
}

data class ScreenCaptureResult(val resultCode: Int, val data: Intent?)

class ScreenCaptureContract : AppContextActivityResultContract<ScreenCaptureRequest, ScreenCaptureResult> {
  override fun createIntent(context: Context, input: ScreenCaptureRequest): Intent {
    val manager = context.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
    return manager.createScreenCaptureIntent()
  }

  override fun parseResult(input: ScreenCaptureRequest, resultCode: Int, intent: Intent?): ScreenCaptureResult {
    return ScreenCaptureResult(resultCode, intent)
  }
}
