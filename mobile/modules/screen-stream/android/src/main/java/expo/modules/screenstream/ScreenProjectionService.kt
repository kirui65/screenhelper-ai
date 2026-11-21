package expo.modules.screenstream

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.DisplayMetrics
import android.view.WindowManager
import androidx.annotation.RequiresApi
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import kotlin.math.max
import kotlin.math.roundToInt

class ScreenProjectionService : Service() {
  private var projection: MediaProjection? = null
  private var display: VirtualDisplay? = null
  private var reader: ImageReader? = null
  private var captureThread: HandlerThread? = null
  private var lastEncodedAt = 0L

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> stopProjection()
      ACTION_START -> startProjection(intent)
    }
    return START_NOT_STICKY
  }

  private fun startProjection(intent: Intent) {
    if (isActive) return
    createNotificationChannel()
    val notification = buildNotification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }

    val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0)
    val resultData = if (Build.VERSION.SDK_INT >= 33) {
      intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
    } else {
      @Suppress("DEPRECATION")
      intent.getParcelableExtra(EXTRA_RESULT_DATA)
    }
    if (resultCode != android.app.Activity.RESULT_OK || resultData == null) {
      stopProjection()
      return
    }

    try {
      val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
      projection = manager.getMediaProjection(resultCode, resultData)
      val metrics = getCaptureMetrics()
      val scale = minOf(1f, MAX_CAPTURE_DIMENSION.toFloat() / max(metrics.widthPixels, metrics.heightPixels))
      val width = max(1, (metrics.widthPixels * scale).roundToInt())
      val height = max(1, (metrics.heightPixels * scale).roundToInt())
      val density = metrics.densityDpi
      captureThread = HandlerThread("ScreenHelperFrameEncoder").apply { start() }
      reader = createImageReader(width, height)
      projection?.registerCallback(projectionCallback, Handler(Looper.getMainLooper()))
      display = projection?.createVirtualDisplay(
        "ScreenHelperScreenCapture",
        width,
        height,
        density,
        DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
        reader?.surface,
        null,
        Handler(Looper.getMainLooper()),
      )
      isActive = display != null
      if (!isActive) stopProjection()
    } catch (_: Exception) {
      stopProjection()
    }
  }

  private fun getCaptureMetrics(): DisplayMetrics {
    val metrics = DisplayMetrics()
    @Suppress("DEPRECATION")
    val display = (getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay
    @Suppress("DEPRECATION")
    display.getRealMetrics(metrics)
    return metrics
  }

  private fun encodeLatestFrame(imageReader: ImageReader) {
    val image = try { imageReader.acquireLatestImage() } catch (_: Exception) { null } ?: return
    try {
      image.use { frame ->
        val now = SystemClock.elapsedRealtime()
        if (now - lastEncodedAt < FRAME_INTERVAL_MS) return
        val plane = frame.planes.firstOrNull() ?: return
        val buffer: ByteBuffer = plane.buffer
        val pixelStride = plane.pixelStride
        val rowStride = plane.rowStride
        val paddedWidth = rowStride / pixelStride
        val bitmap = Bitmap.createBitmap(paddedWidth, frame.height, Bitmap.Config.ARGB_8888)
        try {
          bitmap.copyPixelsFromBuffer(buffer)
          val cropped = Bitmap.createBitmap(bitmap, 0, 0, frame.width, frame.height)
          val out = ByteArrayOutputStream()
          try {
            cropped.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
            latestFrame = if (isActive) out.toByteArray() else null
            latestFrameAt = if (isActive) System.currentTimeMillis() else 0L
            lastEncodedAt = now
          } finally {
            if (cropped !== bitmap) cropped.recycle()
            out.close()
          }
        } finally {
          bitmap.recycle()
        }
      }
    } catch (_: Exception) {
      // A later screen frame can recover if the device changes display size during capture.
    }
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Screen sharing", NotificationManager.IMPORTANCE_LOW))
  }

  private fun buildNotification(): Notification {
    val stopIntent = Intent(this, ScreenProjectionService::class.java).apply { action = ACTION_STOP }
    val pendingStop = PendingIntent.getService(
      this, 0, stopIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0,
    )
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL_ID) else Notification.Builder(this)
    return builder
      .setSmallIcon(android.R.drawable.ic_menu_view)
      .setContentTitle("ScreenHelper is sharing your screen")
      .setContentText("Tap Stop sharing to end screen capture.")
      .setCategory(Notification.CATEGORY_SERVICE)
      .setOngoing(true)
      .addAction(Notification.Action.Builder(android.R.drawable.ic_media_pause, "Stop sharing", pendingStop).build())
      .build()
  }

  private fun stopProjection(stopPlatformProjection: Boolean = true) {
    if (!isActive && projection == null && display == null && reader == null) {
      latestFrame = null
      latestFrameAt = 0L
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
      else {
        @Suppress("DEPRECATION")
        stopForeground(true)
      }
      stopSelf()
      return
    }
    isActive = false
    latestFrame = null
    latestFrameAt = 0L
    display?.release()
    display = null
    reader?.setOnImageAvailableListener(null, null)
    reader?.close()
    reader = null
    captureThread?.quitSafely()
    captureThread = null
    projection?.let { current ->
      current.unregisterCallback(projectionCallback)
      if (stopPlatformProjection) current.stop()
    }
    projection = null
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
    else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
    stopSelf()
  }

  private val projectionCallback = object : MediaProjection.Callback() {
    @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
    override fun onCapturedContentResize(width: Int, height: Int) {
      if (width <= 0 || height <= 0 || display == null) return
      val metrics = getCaptureMetrics()
      val scale = minOf(1f, MAX_CAPTURE_DIMENSION.toFloat() / max(width, height))
      val captureWidth = max(1, (width * scale).roundToInt())
      val captureHeight = max(1, (height * scale).roundToInt())
      val nextReader = createImageReader(captureWidth, captureHeight)
      display?.resize(captureWidth, captureHeight, metrics.densityDpi)
      display?.setSurface(nextReader.surface)
      val previousReader = reader
      reader = nextReader
      previousReader?.setOnImageAvailableListener(null, null)
      previousReader?.close()
      lastEncodedAt = 0L
    }

    override fun onStop() {
      stopProjection(stopPlatformProjection = false)
    }
  }

  private fun createImageReader(width: Int, height: Int): ImageReader {
    val handler = captureThread?.let { Handler(it.looper) }
      ?: throw IllegalStateException("Screen frame worker is not available.")
    return ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2).also { imageReader ->
      imageReader.setOnImageAvailableListener({ source -> encodeLatestFrame(source) }, handler)
    }
  }

  override fun onDestroy() {
    isActive = false
    latestFrame = null
    latestFrameAt = 0L
    display?.release()
    reader?.close()
    captureThread?.quitSafely()
    projection?.unregisterCallback(projectionCallback)
    projection?.stop()
    super.onDestroy()
  }

  companion object {
    const val ACTION_START = "expo.modules.screenstream.START"
    const val ACTION_STOP = "expo.modules.screenstream.STOP"
    const val EXTRA_RESULT_CODE = "screenProjectionResultCode"
    const val EXTRA_RESULT_DATA = "screenProjectionResultData"
    private const val CHANNEL_ID = "screenhelper-screen-sharing"
    private const val NOTIFICATION_ID = 4182
    private const val MAX_CAPTURE_DIMENSION = 2000
    private const val FRAME_INTERVAL_MS = 1000L
    private const val JPEG_QUALITY = 78

    @Volatile var isActive = false
      private set
    @Volatile var latestFrame: ByteArray? = null
      private set
    @Volatile var latestFrameAt = 0L
      private set
  }
}
