{
  "targets": [{
    "target_name": "audio_capture",
    "sources": ["addon.cpp"],
    "include_dirs": [
      "<!@(node -p \"require('node-addon-api').include\")"
    ],
    "defines": ["NAPI_VERSION=8"],
    "cflags!": ["-fno-exceptions"],
    "cflags_cc!": ["-fno-exceptions"],
    "msvs_settings": {
      "VCCLCompilerTool": {
        "ExceptionHandling": 1
      }
    }
  }]
}
