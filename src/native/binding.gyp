{
  "targets": [{
    "target_name": "audio_capture",
    "sources": ["addon.cpp", "wasapi-capture.cpp"],
    "include_dirs": [
      "<!@(node -p \"require('node-addon-api').include\")"
    ],
    "defines": ["NAPI_VERSION=8"],
    "libraries": ["ole32.lib"],
    "cflags!": ["-fno-exceptions"],
    "cflags_cc!": ["-fno-exceptions"],
    "msvs_settings": {
      "VCCLCompilerTool": {
        "ExceptionHandling": 1
      }
    }
  }]
}
